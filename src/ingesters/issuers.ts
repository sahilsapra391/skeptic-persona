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
  /** How `ticker` was chosen. Auditable per row; see `selectIssuerTicker`. */
  tickerSource?: TickerSource;
  /** Other share-class symbols for this CIK; empty unless sec_share_class. */
  tickerAlts?: string;
}

export type TickerSource =
  | "sec_primary" // unsuffixed symbol on a major exchange
  | "sec_primary_otc" // unsuffixed, OTC only
  | "sec_share_class" // no unsuffixed symbol exists; dual-class common (BRK-A/BRK-B)
  | "unresolved"; // only preferred series, warrants, units or rights exist

/**
 * ONE CIK, MANY SYMBOLS — and the file is one-to-many by design.
 *
 * `company_tickers_exchange.json` carries 10,398 rows over 7,999 CIKs, so
 * 1,452 CIKs list more than one symbol. The upsert here is keyed on `cik`, and
 * it used to take whatever row came LAST in SEC's file order. That is a coin
 * flip, not a lookup, and it lost: 269 rows in production held a preferred
 * series, including BANK OF AMERICA at `MER-PK` (a Merrill Lynch preferred),
 * WELLS FARGO at `WFC-PZ`, MORGAN STANLEY at `MS-PQ`, GOLDMAN SACHS at
 * `GS-PD`, AT&T at `T-PC`, BOEING at `BA-PA` and CITIGROUP at `C-PR`.
 *
 * The suffix convention is measured, not assumed (2026-08-08, over the whole
 * live file): of 548 suffixed symbols, 383 are preferred (`-P` + a letter), 29
 * are single-letter share classes (`-A`, `-B`), and 136 are warrants (`-WT`),
 * units (`-UN`) or rights (`-RI`). Only preferred and share classes are even
 * arguable; warrants, units and rights are not common shares at all.
 *
 * Selection is explicit and total, in this order:
 *   1. an unsuffixed symbol on a major exchange   -> sec_primary
 *   2. an unsuffixed symbol anywhere              -> sec_primary_otc
 *   3. no unsuffixed symbol exists, but a single-letter share class does:
 *      take the alphabetically first, deterministically  -> sec_share_class
 *      (only 20 CIKs; BRK-A/BRK-B, BF-A/BF-B, CRD-A/CRD-B and the like)
 *   4. otherwise NO TICKER -> unresolved, and the lane falls back to the
 *      issuer name as filed. Never a preferred series, never a warrant.
 */
const SERIES_SUFFIX = /-(.+)$/;
const PREFERRED_SUFFIX = /^P[A-Z]$/;
const SHARE_CLASS_SUFFIX = /^[A-Z]$/;

/**
 * Does this symbol name something that is NOT a common share -- a preferred
 * series (`WFC-PZ`), a warrant (`-WT`), a unit (`-UN`) or a right (`-RI`)?
 *
 * This is the predicate the standing check uses (B-15.4): no issuer row may
 * ever hold one of these. A single-letter suffix is a genuine common share
 * CLASS (`BRK-A`) and is allowed.
 */
export function isNonCommonSymbol(ticker: string): boolean {
  const m = SERIES_SUFFIX.exec(ticker);
  if (!m) return false;
  return !SHARE_CLASS_SUFFIX.test(m[1]!);
}

/** The narrower case: a preferred series specifically. */
export function isPreferredSeries(ticker: string): boolean {
  const m = SERIES_SUFFIX.exec(ticker);
  return m !== null && PREFERRED_SUFFIX.test(m[1]!);
}

export function selectIssuerTicker(
  candidates: ReadonlyArray<{ ticker: string; exchange: string }>,
): { ticker: string; exchange: string; tickerSource: TickerSource; alts: string[] } {
  const clean = candidates.filter((c) => c.ticker !== "");
  const unsuffixed = clean.filter((c) => !SERIES_SUFFIX.test(c.ticker));

  const major = unsuffixed.filter((c) => MAJOR_EXCHANGES.has(c.exchange));
  // SHORTEST first, then alphabetical. Both halves matter. Alphabetical alone
  // would be settled by luck on AT&T, whose CIK also lists `TBB` -- an
  // unsuffixed NYSE symbol that is a baby bond, not the common share. The
  // common share carries the bare root, so the shorter symbol wins; the
  // alphabetical tiebreak then makes the choice independent of row order.
  const pick = <T extends { ticker: string }>(xs: T[]): T | undefined =>
    xs
      .slice()
      .sort((a, b) => a.ticker.length - b.ticker.length || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))[0];

  const p1 = pick(major);
  if (p1) return { ticker: p1.ticker, exchange: p1.exchange, tickerSource: "sec_primary", alts: [] };

  const p2 = pick(unsuffixed);
  if (p2) return { ticker: p2.ticker, exchange: p2.exchange, tickerSource: "sec_primary_otc", alts: [] };

  const classes = clean.filter((c) => {
    const m = SERIES_SUFFIX.exec(c.ticker);
    return m !== null && SHARE_CLASS_SUFFIX.test(m[1]!) && MAJOR_EXCHANGES.has(c.exchange);
  });
  const p3 = pick(classes);
  if (p3) {
    // The rejected classes are kept, not discarded: a Form 144 that names
    // "Class B Common" can then be answered with BRK-B instead of the
    // alphabetical default (B-10.4 tier 2).
    const alts = classes.map((c) => c.ticker).filter((t) => t !== p3.ticker).sort();
    return { ticker: p3.ticker, exchange: p3.exchange, tickerSource: "sec_share_class", alts };
  }

  // Preferred / warrants / units / rights only. The issuer name is the honest
  // label; a preferred-series cashtag on a common-share transaction is not.
  return { ticker: "", exchange: candidates[0]?.exchange ?? "", tickerSource: "unresolved", alts: [] };
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

  // GROUPED, then SELECTED. Emitting every row and letting the upsert's
  // ON CONFLICT settle it made the choice depend on SEC's row order, which is
  // not a contract and which nothing in the pipeline could audit afterwards.
  const byCik = new Map<number, { name: string; candidates: Array<{ ticker: string; exchange: string }> }>();
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const cik = Number(r[iCik]);
    const exchange = r[iExch] === null || r[iExch] === undefined ? "" : String(r[iExch]);
    const ticker = String(r[iTicker] ?? "");
    const name = String(r[iName] ?? "");
    if (!Number.isFinite(cik) || cik <= 0 || !name) continue;
    const entry = byCik.get(cik);
    if (entry) entry.candidates.push({ ticker, exchange });
    else byCik.set(cik, { name, candidates: [{ ticker, exchange }] });
  }

  const out: IssuerRow[] = [];
  for (const [cik, { name, candidates }] of byCik) {
    const chosen = selectIssuerTicker(candidates);
    out.push({
      cik, name,
      ticker: chosen.ticker,
      exchange: chosen.exchange,
      tickerSource: chosen.tickerSource,
      tickerAlts: chosen.alts.join(","),
    });
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
  /** Comma-separated OTHER share-class symbols for this CIK, populated only
   *  when no unsuffixed symbol exists (BRK-A/BRK-B). Lets the resolution chain
   *  honour B-10.4 tier 2 and pick the class the filing itself names. */
  tickerAlts?: string | null;
}

export async function lookupIssuer(env: Env, cik: string | number): Promise<Issuer | null> {
  const n = Number(cik);
  if (!Number.isFinite(n) || n <= 0) return null;
  const row = await env.DB.prepare(
    `SELECT cik, name, ticker, exchange, public_float AS publicFloat, ticker_alts AS tickerAlts
       FROM issuers WHERE cik = ?1`,
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
    | "reference_unavailable"
    | "no_issuer_cik";
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

/**
 * The whole gate in one call: look the issuer up, judge the reference, decide.
 *
 * Takes the ISSUER's CIK. Every filing form in this repo also carries a
 * filer-side CIK -- rptOwnerCik on Form 4, reportingPersonCIK on Schedule 13 --
 * and those identify a PERSON. Passing one here would look a human up in a
 * table of companies, find nothing, and (since absence became evidence)
 * suppress every filing of that type. Verified field name on all three:
 * `issuerCik`.
 */
export interface GateContext {
  /** Whether absence from the reference may be read as "not listed". */
  authoritative: boolean;
  floorUsd: number;
}

/**
 * Build the gate's batch-scoped context. Call ONCE per run, never per filing.
 *
 * referenceHealth is `SELECT COUNT(*), MAX(updated_at) FROM issuers`, and
 * MAX over an unindexed column means D1 scans the table -- 12,000 rows read
 * per call against a real ticker file, versus 1 for the lookupIssuer primary
 * key hit.
 *
 * Per filing that is ruinous. Measured across the three detail lanes at their
 * real cadences and batch sizes: form4 3,840 gate calls/day, schedule13
 * 1,536, form144 2,304 -- roughly 87M rows/day against a documented 5M/day
 * cap, exhausted in about 17 minutes of saturated batches. And because the
 * jobs table, the dedup ledger and the approval queue are all D1, the
 * consequence is not three degraded sources, it is every query failing.
 *
 * The 8-K lane already hoists this (edgar8k.ts, "Read the reference health
 * ONCE per batch, not per filing"); this type makes the hoist structural so
 * the mistake cannot be made again by passing `env` and hoping.
 */
export async function gateContext(env: Env, now: Date): Promise<GateContext> {
  return {
    authoritative: referenceIsAuthoritative(await referenceHealth(env), now),
    floorUsd: minFloatUsd(env),
  };
}

export async function issuerGate(env: Env, issuerCik: string | number, ctx: GateContext): Promise<GateResult> {
  // "We could not read an issuer CIK" is NOT "this issuer is not listed".
  // lookupIssuer returns null for both, and after #64 a null means suppress,
  // so without this an unparsed field would be read as evidence of
  // non-listing. The gate only ever acts on a POSITIVE finding; deciding what
  // an unparsed issuer is worth belongs to each source's own scorer, which
  // already log-onlys them.
  const n = Number(issuerCik);
  if (!Number.isFinite(n) || n <= 0) return { keep: true, reason: "no_issuer_cik" };

  return keepIssuer(await lookupIssuer(env, issuerCik), ctx.floorUsd, ctx.authoritative);
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
            `INSERT INTO issuers (cik, name, ticker, exchange, public_float, updated_at, ticker_source, ticker_alts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(cik) DO UPDATE SET
               name = excluded.name,
               ticker = excluded.ticker,
               exchange = excluded.exchange,
               ticker_source = excluded.ticker_source,
               ticker_alts = excluded.ticker_alts,
               -- A refresh that could not see a float must not ERASE one we
               -- already had; only a newer real value replaces it.
               public_float = COALESCE(excluded.public_float, issuers.public_float),
               updated_at = excluded.updated_at`,
          ).bind(r.cik, r.name, r.ticker, r.exchange, floats.get(r.cik)?.val ?? null, iso(now), r.tickerSource ?? "", r.tickerAlts ?? ""),
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
