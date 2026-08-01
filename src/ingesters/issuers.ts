import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, putSourceState, recordSourceError } from "../lib/db";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// The ISSUER REFERENCE TABLE: which EDGAR filers are actually tradeable
// companies, and how big their public float is.
//
// WHY: EDGAR's filer universe is hundreds of thousands of CIKs, most of which
// are funds, trusts, shells and non-traded vehicles. Measured against 447
// live 8-K items on 2026-07-28, 17% came from filers with no listing at all
// -- BlackRock Private Credit Fund, KKR Infrastructure Conglomerate, Golub
// Capital Private Credit Fund -- and another 29% from issuers under $300M of
// public float. Those are real filings and they stay in the lake; they are
// just not what a market-intelligence desk interrupts anyone about.
//
// BOTH FIELDS ARE THE COMPANIES' OWN, filed with the SEC. The exchange comes
// from SEC's published ticker file and the float from dei:EntityPublicFloat,
// which each registrant reports on its own annual-report cover page. No
// vendor data (non-negotiable #3).
export const SOURCE = "issuer_refresh";

/** SEC's own CIK -> ticker -> exchange file. */
export const TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";

/**
 * Public float is measured at the last business day of a registrant's most
 * recently completed SECOND fiscal quarter, so a December filer lands in
 * CY..Q2I and everyone else scatters. Several frames are unioned and the
 * newest value per CIK wins.
 *
 * Non-December filers can still fall outside this window entirely. That is
 * why an absent float means UNKNOWN and never zero -- see keepIssuer.
 */
export const FLOAT_FRAMES: readonly string[] = [
  "CY2025Q1I",
  "CY2025Q2I",
  "CY2025Q3I",
  "CY2025Q4I",
  "CY2026Q1I",
];

export function floatFrameUrl(frame: string): string {
  return `https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/${frame}.json`;
}

/**
 * Exchanges whose listings we treat as tradeable. OTC is excluded
 * deliberately: it is where the shells live, and an OTC ticker is not a
 * market anyone reading this desk trades.
 */
export const MAJOR_EXCHANGES: ReadonlySet<string> = new Set(["Nasdaq", "NYSE", "CBOE"]);

export interface IssuerRow {
  cik: number;
  name: string;
  ticker: string;
  exchange: string;
}

/** SEC serves {fields: [...], data: [[...]]}, positional, not keyed. */
export function parseTickerFile(body: string): IssuerRow[] {
  const doc = JSON.parse(body) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(doc.fields) ? doc.fields.map(String) : [];
  const rows = Array.isArray(doc.data) ? doc.data : [];
  // Read columns BY NAME. SEC publishes the header in the file precisely so
  // callers do not hardcode positions, and a silent column reorder here would
  // file every 8-K under the wrong exchange.
  const iCik = fields.indexOf("cik");
  const iName = fields.indexOf("name");
  const iTicker = fields.indexOf("ticker");
  const iExch = fields.indexOf("exchange");
  if (iCik < 0 || iName < 0 || iTicker < 0 || iExch < 0) return [];

  const out: IssuerRow[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const cik = Number(r[iCik]);
    const exchange = r[iExch] === null || r[iExch] === undefined ? "" : String(r[iExch]);
    const ticker = String(r[iTicker] ?? "");
    const name = String(r[iName] ?? "");
    if (!Number.isFinite(cik) || cik <= 0 || !name) continue;
    out.push({ cik, name, ticker, exchange });
  }
  return out;
}

/** One XBRL frame: {data: [{cik, entityName, end, val}, ...]}. */
export function parseFloatFrame(body: string): Map<number, { end: string; val: number }> {
  const doc = JSON.parse(body) as { data?: unknown };
  const out = new Map<number, { end: string; val: number }>();
  for (const d of Array.isArray(doc.data) ? doc.data : []) {
    const row = d as Record<string, unknown>;
    const cik = Number(row.cik);
    const val = Number(row.val);
    const end = String(row.end ?? "");
    if (!Number.isFinite(cik) || !Number.isFinite(val) || !end) continue;
    // A float of 0 is what a pre-IPO measurement date reports, not a company
    // worth nothing. Dropped here so it reads as UNKNOWN downstream.
    if (val <= 0) continue;
    const prev = out.get(cik);
    if (!prev || end > prev.end) out.set(cik, { end, val });
  }
  return out;
}

export interface Issuer {
  cik: number;
  name: string;
  ticker: string;
  exchange: string;
  publicFloat: number | null;
}

export async function lookupIssuer(env: Env, cik: string | number): Promise<Issuer | null> {
  const n = Number(cik);
  if (!Number.isFinite(n) || n <= 0) return null;
  const row = await env.DB.prepare(
    `SELECT cik, name, ticker, exchange, public_float AS publicFloat FROM issuers WHERE cik = ?1`,
  )
    .bind(n)
    .first<Issuer>();
  return row ?? null;
}

/** Below this, a filing goes to the lake instead of the queue. */
export const DEFAULT_MIN_FLOAT_USD = 300_000_000;

export interface GateResult {
  keep: boolean;
  reason:
    | "major_exchange"
    | "float_unknown"
    | "not_listed"
    | "minor_exchange"
    | "below_float"
    | "not_in_reference"
    | "reference_unavailable";
}

/**
 * The reference table is only allowed to speak for the whole market when it
 * plausibly covers it. Below this many rows a partial or failed refresh could
 * silence everything, so absence stops meaning anything.
 */
export const MIN_AUTHORITATIVE_ROWS = 5_000;

/** Beyond this, the table is too old for absence to be evidence. */
export const MAX_REFERENCE_AGE_DAYS = 7;

export interface ReferenceHealth {
  rows: number;
  updatedAt: string | null;
}

/**
 * Is the reference table complete and fresh enough that a MISSING issuer
 * means "not listed" rather than "not looked up yet"?
 */
export function referenceIsAuthoritative(health: ReferenceHealth, now: Date): boolean {
  if (health.rows < MIN_AUTHORITATIVE_ROWS) return false;
  if (!health.updatedAt) return false;
  const age = now.getTime() - new Date(health.updatedAt).getTime();
  if (!Number.isFinite(age)) return false;
  return age <= MAX_REFERENCE_AGE_DAYS * 86_400_000;
}

export async function referenceHealth(env: Env): Promise<ReferenceHealth> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS rows, MAX(updated_at) AS updatedAt FROM issuers`,
  ).first<{ rows: number; updatedAt: string | null }>();
  return { rows: row?.rows ?? 0, updatedAt: row?.updatedAt ?? null };
}

/**
 * Should a filing from this issuer be allowed to interrupt the owner?
 *
 * An absent FLOAT always fails open: Donaldson and Estee Lauder both have
 * June/July fiscal years, so their float instant falls outside the frames we
 * union, and a rule that read missing-as-zero would silence two large caps.
 *
 * An absent ISSUER depends on whether the reference covers the market. SEC's
 * ticker file lists every exchange-listed filer, so a name missing from a
 * complete and fresh copy of it is a non-traded vehicle -- but a table that
 * is small or stale cannot tell "not listed" from "not refreshed", and
 * reading a failed refresh as "nothing is listed" would silence every filing
 * source at once. See referenceIsAuthoritative.
 */
export function keepIssuer(
  issuer: Issuer | null,
  minFloatUsd = DEFAULT_MIN_FLOAT_USD,
  referenceAuthoritative = false,
): GateResult {
  if (!issuer) {
    // ABSENCE IS EVIDENCE, but only from a table that covers the market.
    // SEC's ticker file lists every exchange-listed issuer; a filer missing
    // from it is a non-traded vehicle, and measured on 2026-07-28 that bucket
    // was 45 of 455 live 8-K items -- BlackRock Private Credit Fund,
    // Blackstone Private Credit Fund, KKR Infrastructure Conglomerate, three
    // Golub Capital funds, PennantPark, Ares Strategic Income. Exactly the
    // filings this gate exists to hold.
    //
    // When the table is small or stale we cannot tell "not listed" from "not
    // refreshed", so absence means nothing and the filing passes.
    return referenceAuthoritative
      ? { keep: false, reason: "not_in_reference" }
      : { keep: true, reason: "reference_unavailable" };
  }
  if (!issuer.exchange) return { keep: false, reason: "not_listed" };
  if (!MAJOR_EXCHANGES.has(issuer.exchange)) return { keep: false, reason: "minor_exchange" };
  if (issuer.publicFloat === null) return { keep: true, reason: "float_unknown" };
  if (issuer.publicFloat < minFloatUsd) return { keep: false, reason: "below_float" };
  return { keep: true, reason: "major_exchange" };
}

export function minFloatUsd(env: Env): number {
  const raw = Number(env.MIN_ISSUER_FLOAT_USD ?? DEFAULT_MIN_FLOAT_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_FLOAT_USD;
}

/** D1 caps bound parameters per statement; 400 rows x 5 columns stays clear. */
const UPSERT_CHUNK = 400;

export async function refreshIssuers(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  // One ticker file plus the float frames.
  if (!budget.take(1 + FLOAT_FRAMES.length)) return;
  const state = await getSourceState(env.DB, SOURCE);
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);

  try {
    const res = await politeFetch(TICKERS_URL, { userAgent, timeoutMs: 45_000 });
    if (!res.ok) throw new Error(`tickers ${res.status}`);
    const issuers = parseTickerFile(res.body);
    if (issuers.length === 0) throw new Error("ticker file parsed to zero issuers");

    // Floats are a BONUS: a frame that fails leaves those issuers at unknown,
    // which the gate treats as "keep". Never fail the whole refresh for one.
    const floats = new Map<number, { end: string; val: number }>();
    for (const frame of FLOAT_FRAMES) {
      try {
        const f = await politeFetch(floatFrameUrl(frame), { userAgent, timeoutMs: 45_000 });
        if (!f.ok) {
          log("warn", "float frame unavailable; issuers stay unknown", { frame, status: f.status });
          continue;
        }
        for (const [cik, v] of parseFloatFrame(f.body)) {
          const prev = floats.get(cik);
          if (!prev || v.end > prev.end) floats.set(cik, v);
        }
      } catch (e) {
        log("warn", "float frame threw; issuers stay unknown", { frame, error: String(e) });
      }
    }

    for (let i = 0; i < issuers.length; i += UPSERT_CHUNK) {
      const chunk = issuers.slice(i, i + UPSERT_CHUNK);
      await env.DB.batch(
        chunk.map((r) =>
          env.DB.prepare(
            `INSERT INTO issuers (cik, name, ticker, exchange, public_float, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(cik) DO UPDATE SET
               name = excluded.name,
               ticker = excluded.ticker,
               exchange = excluded.exchange,
               -- A refresh that could not see a float must not ERASE one we
               -- already had; only a newer real value replaces it.
               public_float = COALESCE(excluded.public_float, issuers.public_float),
               updated_at = excluded.updated_at`,
          ).bind(r.cik, r.name, r.ticker, r.exchange, floats.get(r.cik)?.val ?? null, iso(now)),
        ),
      );
    }

    log("info", "issuer table refreshed", { issuers: issuers.length, floats: floats.size });
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    await recordSourceError(env.DB, SOURCE, e, now);
    log("error", "issuer refresh failed", { error: String(e), failures: state.consecutiveFailures });
  }
}
