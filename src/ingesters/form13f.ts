import type { Env } from "../env";
import { fetchPool, newTickBudget, SEC_POOL_CONCURRENCY, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAll, extractAllNs, extractAttr, extractFirst, extractFirstNs, stripBom } from "../lib/xml";
import { getSourceState, putSourceState, recordSourceError } from "../lib/db";
import { resolveCusipBatch } from "../lib/figi";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// 13F-01 (SKEPTIC-WIRE-13F-LANE-PLAN.md). Reuses the EDGAR current feed the
// 8-K lane already polls — same politeness stack, same atom shape — with a
// form-type filter. type= is PREFIX match (verified live on the 8-K lane), so
// type=13F returns 13F-HR, 13F-HR/A, 13F-NT and 13F-NT/A in one feed.
//
// Verified live 2026-08-04 (docs/verification/2026-08-04-13f-01.md): the feed
// carried 33 13F-HR + 7 13F-NT in its top 40 — the Q2 window is already
// producing, ahead of the 2026-08-14 deadline flood this lane exists for.
const FEED_BASE =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=13F&company=&dateb=&owner=include&output=atom";
export const EDGAR_13F_FEED = `${FEED_BASE}&count=100`;
export const SOURCE = "edgar_13f";

/** Exact allowed set. The prefix filter can in principle surface other 13F*
 *  form names; anything outside this set is dropped, not guessed at. */
export const ALLOWED_FORMS: ReadonlySet<string> = new Set(["13F-HR", "13F-HR/A", "13F-NT", "13F-NT/A"]);

/** Feed pages fetched per poll once page 1 is entirely new (deadline flood).
 *  3 pages x 100 entries x 48 polls/day comfortably covers the ~5k-filing
 *  deadline day; a normal day never leaves page 1. */
export const MAX_FEED_PAGES = 3;

/** Watchlist infotables above this parse in the heavy lane, not the Worker.
 *  MERIDIAN's real Q2 infotable (112 positions) is 55 KB, so 3 MB is roughly
 *  a 6,000-position filing — nothing a tier-1 discretionary manager files.
 *  Env-overridable: THIRTEENF_INLINE_MAX_BYTES. */
export const INLINE_MAX_BYTES_DEFAULT = 3_000_000;

/** Watchlist filings parsed per tick. Each costs up to 3 sequential fetches
 *  (index.json, primary_doc, infotable), so 2 filings stays inside one tick's
 *  budget alongside the feed fetch. */
const PARSE_BATCH_PER_RUN = 2;

// --- sanity gates (the units defense; env-overridable, defaults stated) -----
//
// Three independent gates, because the failure modes differ:
//  - ceilings catch too-BIG (a dollars figure misread as thousands, ours);
//  - the declared-total cross-check catches OUR parse disagreeing with the
//    filer's own tableValueTotal (either side wrong -> do not trust);
//  - the implied-price gate catches too-SMALL (a filer reporting in thousands
//    against the whole-dollar rule: every equity row's value/shares lands at
//    ~1/1000 of any plausible share price). Portfolio-size floors cannot catch
//    that for large filers; implied price catches it at any size.
export const SANITY_MAX_TOTAL_USD_DEFAULT = 5_000_000_000_000; // $5T
export const SANITY_MAX_POSITION_USD_DEFAULT = 500_000_000_000; // $500B (BRK's AAPL peaked ~$170B)
export const SANITY_MIN_TOTAL_USD_DEFAULT = 50_000_000; // $50M; watchlist managers are all far larger
/** |parsed - declared| / declared beyond this quarantines (filer or us). */
export const TOTAL_MISMATCH_TOLERANCE = 0.02;
/** Equity rows (SH, no put/call) with implied price outside [$0.50, $50,000]
 *  are suspicious; beyond this fraction of rows, quarantine. */
export const IMPLIED_PRICE_SUSPECT_FRACTION = 0.2;

export interface Feed13fEntry {
  accession: string;
  cik: string;
  company: string;
  form: string;
  indexUrl: string;
  dirUrl: string; // Archives directory (indexUrl minus the -index.htm leaf)
  filedIso: string;
}

const ACCESSION_RE = /accession-number=([0-9-]+)/;
const TITLE_RE = /^(13F-[A-Z/]+) - (.+) \((\d{10})\) \(Filer\)$/;

export function parse13fFeed(xml: string): Feed13fEntry[] {
  const out: Feed13fEntry[] = [];
  const seen = new Set<string>();
  for (const entry of extractAll(stripBom(xml), "entry")) {
    const accession = ACCESSION_RE.exec(extractFirst(entry, "id") ?? "")?.[1];
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);

    // category term is authoritative for the form type (8-K lane precedent).
    const form = extractAttr(entry, "category", "term") ?? "";
    if (!ALLOWED_FORMS.has(form)) continue;

    const title = decodeEntities(extractFirst(entry, "title") ?? "");
    const tm = TITLE_RE.exec(title);
    const company = tm?.[2] ?? title;
    const cik = (tm?.[3] ?? "").replace(/^0+/, "");
    const indexUrl = extractAttr(entry, "link", "href") ?? "";
    const dirUrl = indexUrl.replace(/\/[^/]*-index\.htm[l]?$/, "");

    const updated = extractFirst(entry, "updated") ?? "";
    const filedAt = new Date(updated);
    const filedIso = Number.isNaN(filedAt.getTime()) ? "" : filedAt.toISOString();

    if (!cik || !indexUrl || !filedIso) continue; // a field that didn't parse is never claimed
    out.push({ accession, cik, company, form, indexUrl, dirUrl, filedIso });
  }
  return out;
}

/** periodOfReport arrives as MM-DD-YYYY (verified live on a real Q2 filing) —
 *  a FIFTH date convention for the normalize-at-parse rule. Returns ISO date
 *  or null; never guesses. */
export function normalizePeriod(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw.trim());
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  const isoM = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  return isoM ? raw.trim() : null;
}

export interface Holding13f {
  cusip: string;
  putCall: string; // '' | 'Put' | 'Call'
  issuer: string;
  cls: string;
  valueUsd: number;
  shares: number;
  shPrnType: string;
  discretion: string;
  votingSole: number;
  votingShared: number;
  votingNone: number;
}

/**
 * Parse an informationTable XML into AGGREGATED positions.
 *
 * Filers report the same security in multiple lots (verified live: MERIDIAN's
 * real Q2 filing lists ALPHABET twice — 19,422 sh and 43 sh, different
 * discretion lots). The desk cares about the position, so lots aggregate on
 * (cusip, putCall): values and shares sum, voting sums, discretion collapses
 * to MIXED when lots disagree.
 *
 * Values are WHOLE DOLLARS: rounding-to-dollar effective 2023-01-03 per the
 * Form 13F FAQ (verified from sec.gov 2026-08-04); our scope is 2025+ so no
 * thousands-era rows can reach this parser legitimately — a filer still
 * reporting in thousands is what the implied-price gate exists for.
 *
 * OPTIONS ROWS: per FAQ Q44 (updated 2023-01-03), columns 1-5 and 7-8 of an
 * option row refer to the UNDERLYING security, not the option — so valueUsd
 * and shares here are the underlying's value and share count. Copy must never
 * frame these as premium paid or dollars at risk (copy law; enforced by
 * 13F-04 templates, recorded here because this is the parser contract).
 */
export function parseInfotable(xml: string): Holding13f[] {
  const agg = new Map<string, Holding13f>();
  for (const block of extractAllNs(stripBom(xml), "infoTable")) {
    const cusip = (extractFirstNs(block, "cusip") ?? "").trim().toUpperCase();
    if (!/^[0-9A-Z]{9}$/.test(cusip)) continue; // malformed row: never claimed
    const valueRaw = (extractFirstNs(block, "value") ?? "").replace(/[,\s]/g, "");
    const sharesRaw = (extractFirstNs(block, "sshPrnamt") ?? "").replace(/[,\s]/g, "");
    const valueUsd = Number(valueRaw);
    const shares = Number(sharesRaw);
    if (!Number.isFinite(valueUsd) || !Number.isFinite(shares)) continue;

    const putCallRaw = (extractFirstNs(block, "putCall") ?? "").trim().toLowerCase();
    const putCall = putCallRaw === "put" ? "Put" : putCallRaw === "call" ? "Call" : "";
    const issuer = decodeEntities(extractFirstNs(block, "nameOfIssuer") ?? "").trim();
    const cls = decodeEntities(extractFirstNs(block, "titleOfClass") ?? "").trim();
    const shPrnType = (extractFirstNs(block, "sshPrnamtType") ?? "").trim().toUpperCase();
    const discretion = (extractFirstNs(block, "investmentDiscretion") ?? "").trim().toUpperCase();
    const vote = (tag: string): number => {
      const n = Number((extractFirstNs(block, tag) ?? "0").replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    const key = `${cusip}|${putCall}`;
    const prior = agg.get(key);
    if (!prior) {
      agg.set(key, {
        cusip, putCall, issuer, cls, valueUsd, shares, shPrnType, discretion,
        votingSole: vote("Sole"), votingShared: vote("Shared"), votingNone: vote("None"),
      });
    } else {
      prior.valueUsd += valueUsd;
      prior.shares += shares;
      prior.votingSole += vote("Sole");
      prior.votingShared += vote("Shared");
      prior.votingNone += vote("None");
      if (prior.shPrnType !== shPrnType) prior.shPrnType = "";
      if (prior.discretion !== discretion) prior.discretion = "MIXED";
    }
  }
  return [...agg.values()];
}

export interface SanityVerdict {
  ok: boolean;
  reason: string | null;
  parsedTotal: number;
}

export function sanityCheck(
  holdings: readonly Holding13f[],
  declaredTotal: number | null,
  env: Env,
): SanityVerdict {
  const maxTotal = Number(env.SANITY_MAX_TOTAL_USD ?? SANITY_MAX_TOTAL_USD_DEFAULT) || SANITY_MAX_TOTAL_USD_DEFAULT;
  const maxPos = Number(env.SANITY_MAX_POSITION_USD ?? SANITY_MAX_POSITION_USD_DEFAULT) || SANITY_MAX_POSITION_USD_DEFAULT;
  const minTotal = Number(env.SANITY_MIN_TOTAL_USD ?? SANITY_MIN_TOTAL_USD_DEFAULT) || SANITY_MIN_TOTAL_USD_DEFAULT;

  const parsedTotal = holdings.reduce((n, h) => n + h.valueUsd, 0);
  if (holdings.length === 0) return { ok: false, reason: "empty_table", parsedTotal };
  if (parsedTotal > maxTotal) return { ok: false, reason: "total_above_ceiling", parsedTotal };
  if (parsedTotal < minTotal) return { ok: false, reason: "total_below_floor", parsedTotal };
  for (const h of holdings) {
    if (h.valueUsd > maxPos) return { ok: false, reason: "position_above_ceiling", parsedTotal };
  }
  if (declaredTotal !== null && declaredTotal > 0) {
    const drift = Math.abs(parsedTotal - declaredTotal) / declaredTotal;
    if (drift > TOTAL_MISMATCH_TOLERANCE) return { ok: false, reason: "total_mismatch_vs_declared", parsedTotal };
  }
  const equityRows = holdings.filter((h) => h.putCall === "" && h.shPrnType === "SH" && h.shares > 0);
  if (equityRows.length >= 5) {
    const suspect = equityRows.filter((h) => {
      const implied = h.valueUsd / h.shares;
      return implied < 0.5 || implied > 50_000;
    }).length;
    if (suspect / equityRows.length > IMPLIED_PRICE_SUSPECT_FRACTION) {
      return { ok: false, reason: "implied_price_out_of_range", parsedTotal };
    }
  }
  return { ok: true, reason: null, parsedTotal };
}

interface PendingFiling {
  id: number;
  cik: string;
  accession: string;
  dir_url: string;
}

async function watchlistCiks(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare(`SELECT cik FROM managers_13f`).all<{ cik: string }>();
  return new Set(rows.results.map((r) => r.cik));
}

export async function pollForm13f(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);
  const state = await getSourceState(env.DB, SOURCE);
  const watchlist = await watchlistCiks(env);

  try {
    let inserted = 0;
    for (let page = 0; page < MAX_FEED_PAGES; page++) {
      if (!budget.take(1)) break;
      const url = page === 0 ? EDGAR_13F_FEED : `${EDGAR_13F_FEED}&start=${page * 100}`;
      const res = await politeFetch(url, { userAgent, timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`13F feed page ${page} ${res.status}`);
      const entries = parse13fFeed(res.body);
      if (page === 0 && entries.length === 0) throw new Error("13F feed parsed to zero entries");

      let newOnPage = 0;
      for (const e of entries) {
        const isWatch = watchlist.has(e.cik) && (e.form === "13F-HR" || e.form === "13F-HR/A");
        const status = e.form.startsWith("13F-NT") ? "nt_linked" : isWatch ? "pending_parse" : "metadata";
        const r = await env.DB.prepare(
          `INSERT OR IGNORE INTO filings_13f (accession, cik, manager_name, form, filed_at, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
          .bind(e.accession, e.cik, e.company, e.form, e.filedIso, status, iso(now))
          .run();
        if ((r.meta.changes ?? 0) > 0) {
          newOnPage += 1;
          // dir_url is derivable from cik+accession; stored per-parse below.
        }
      }
      inserted += newOnPage;
      // Deeper pages only while the window is flooding: a page that was not
      // entirely new means we have reached filings we already hold.
      if (newOnPage < entries.length || entries.length === 0) break;
    }
    if (inserted > 0) log("info", "13F feed drained", { inserted });
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    await recordSourceError(env.DB, SOURCE, e, now);
    log("error", "13F feed poll failed", { error: String(e) });
  }

  // Watchlist parse drain. Runs even when the feed fetch failed: pending rows
  // are prior ticks' work and a feed hiccup must not stall them.
  const pending = await env.DB.prepare(
    `SELECT f.id, f.cik, f.accession FROM filings_13f f
     WHERE f.status = 'pending_parse' ORDER BY f.id LIMIT ?1`,
  )
    .bind(PARSE_BATCH_PER_RUN)
    .all<Omit<PendingFiling, "dir_url">>();

  // 3 sequential fetches per filing; only start what the budget can fund.
  const affordable = pending.results.filter(() => budget.take(3));
  if (affordable.length === 0) return;

  const inlineMax = Number(env.THIRTEENF_INLINE_MAX_BYTES ?? INLINE_MAX_BYTES_DEFAULT) || INLINE_MAX_BYTES_DEFAULT;

  await fetchPool(
    affordable,
    async (row) => {
      const accNoDash = row.accession.replace(/-/g, "");
      const dirUrl = `https://www.sec.gov/Archives/edgar/data/${row.cik}/${accNoDash}`;
      try {
        // 1. index.json: the directory listing with names and sizes.
        const idxRes = await politeFetch(`${dirUrl}/index.json`, { userAgent, timeoutMs: 20_000 });
        if (!idxRes.ok) throw new Error(`index.json ${idxRes.status}`);
        const idx = JSON.parse(idxRes.body) as { directory?: { item?: Array<{ name: string; size?: string | number }> } };
        const files = idx.directory?.item ?? [];
        const xmls = files.filter((f) => /\.xml$/i.test(f.name));
        const primaryName = xmls.find((f) => /primary_doc\.xml$/i.test(f.name))?.name ?? "primary_doc.xml";
        const tableCandidates = xmls.filter((f) => f.name !== primaryName);

        // 2. primary_doc: period, declared totals, amendment type.
        const priRes = await politeFetch(`${dirUrl}/${primaryName}`, { userAgent, timeoutMs: 20_000 });
        if (!priRes.ok) throw new Error(`primary_doc ${priRes.status}`);
        const period = normalizePeriod(extractFirstNs(priRes.body, "periodOfReport"));
        const declaredTotalRaw = (extractFirstNs(priRes.body, "tableValueTotal") ?? "").replace(/[,\s]/g, "");
        const declaredTotal = Number.isFinite(Number(declaredTotalRaw)) && declaredTotalRaw !== "" ? Number(declaredTotalRaw) : null;
        const declaredEntriesRaw = (extractFirstNs(priRes.body, "tableEntryTotal") ?? "").replace(/[,\s]/g, "");
        const declaredEntries = Number.isFinite(Number(declaredEntriesRaw)) && declaredEntriesRaw !== "" ? Number(declaredEntriesRaw) : null;
        const amendmentType = (extractFirstNs(priRes.body, "amendmentType") ?? "").trim() || null;

        // 3. infotable: pick by size within the inline ceiling, sniff content.
        const sized = tableCandidates
          .map((f) => ({ name: f.name, size: Number(f.size ?? 0) || 0 }))
          .sort((a, b) => b.size - a.size);
        const chosen = sized[0];
        if (!chosen) throw new Error("no infotable candidate in index");
        if (chosen.size > inlineMax) {
          await env.DB.prepare(
            `UPDATE filings_13f SET status = 'deferred_heavy', period = ?2, amendment_type = ?3,
                    infotable_bytes = ?4, table_value_total = ?5, table_entry_total = ?6 WHERE id = ?1`,
          )
            .bind(row.id, period, amendmentType, chosen.size, declaredTotal, declaredEntries)
            .run();
          log("warn", "13F infotable deferred to heavy lane", { accession: row.accession, bytes: chosen.size });
          return;
        }
        const tblRes = await politeFetch(`${dirUrl}/${chosen.name}`, { userAgent, timeoutMs: 20_000 });
        if (!tblRes.ok) throw new Error(`infotable ${tblRes.status}`);
        if (!/<\w*:?informationTable/i.test(tblRes.body)) throw new Error("candidate is not an informationTable");

        const holdings = parseInfotable(tblRes.body);
        const verdict = sanityCheck(holdings, declaredTotal, env);

        if (!verdict.ok) {
          await env.DB.prepare(
            `UPDATE filings_13f SET status = 'quarantined', quarantine_reason = ?2, period = ?3,
                    amendment_type = ?4, infotable_bytes = ?5, table_value_total = ?6,
                    table_entry_total = ?7, parsed_value_total = ?8 WHERE id = ?1`,
          )
            .bind(row.id, verdict.reason, period, amendmentType, chosen.size, declaredTotal, declaredEntries, verdict.parsedTotal)
            .run();
          // No figures quoted beyond the log, by design: a quarantined filing
          // must never contribute numbers anywhere downstream.
          log("error", "13F filing failed sanity checks", {
            accession: row.accession, cik: row.cik, reason: verdict.reason,
            parsedTotal: verdict.parsedTotal, declaredTotal,
          });
          return;
        }

        // Batch: holdings + status flip travel together — a partial insert
        // must not leave a filing half-parsed under status 'parsed'.
        const stmts = holdings.map((h) =>
          env.DB.prepare(
            `INSERT OR REPLACE INTO holdings_13f
             (filing_id, cusip, put_call, issuer, class, value_usd, shares, sh_prn_type,
              discretion, voting_sole, voting_shared, voting_none)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          ).bind(row.id, h.cusip, h.putCall, h.issuer, h.cls, h.valueUsd, h.shares, h.shPrnType, h.discretion, h.votingSole, h.votingShared, h.votingNone),
        );
        stmts.push(
          env.DB.prepare(
            `UPDATE filings_13f SET status = 'parsed', period = ?2, amendment_type = ?3,
                    infotable_bytes = ?4, table_value_total = ?5, table_entry_total = ?6,
                    parsed_value_total = ?7 WHERE id = ?1`,
          ).bind(row.id, period, amendmentType, chosen.size, declaredTotal, declaredEntries, verdict.parsedTotal),
        );
        await env.DB.batch(stmts);
        log("info", "13F filing parsed", {
          accession: row.accession, cik: row.cik, positions: holdings.length,
          parsedTotal: verdict.parsedTotal, period,
        });
      } catch (e) {
        // Park rather than retry-forever: the drain is ORDER BY id LIMIT n,
        // so a permanently-failing filing would head-of-line block the lane
        // (the enqueue precedent). parse_failed is visible and re-openable.
        await env.DB.prepare(`UPDATE filings_13f SET status = 'parse_failed', quarantine_reason = ?2 WHERE id = ?1`)
          .bind(row.id, String(e).slice(0, 200))
          .run();
        log("error", "13F parse failed; filing parked", { accession: row.accession, error: String(e) });
      }
    },
    SEC_POOL_CONCURRENCY,
  );

  // CUSIP resolution drain (13F-02): one openFIGI batch per tick against
  // holdings whose cusip is not yet in cusip_map. Budget-aware; misses are
  // cached so the set strictly shrinks. ~84 distinct CUSIPs per new filing
  // resolve inside ~9 ticks (~4.5h at every_30m), well ahead of any card.
  if (budget.take(1)) {
    const unmapped = await env.DB.prepare(
      `SELECT DISTINCT h.cusip FROM holdings_13f h
       LEFT JOIN cusip_map m ON m.cusip = h.cusip
       WHERE m.cusip IS NULL LIMIT 10`,
    ).all<{ cusip: string }>();
    if (unmapped.results.length > 0) {
      try {
        const n = await resolveCusipBatch(env, unmapped.results.map((r) => r.cusip), now);
        if (n > 0) log("info", "cusip batch resolved", { resolved: n });
      } catch (e) {
        log("warn", "cusip resolution failed; retried next tick", { error: String(e) });
      }
    }
  }
}
