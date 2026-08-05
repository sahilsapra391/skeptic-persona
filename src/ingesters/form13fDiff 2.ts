import type { Env } from "../env";
import { iso } from "../lib/time";
import { log } from "../lib/log";
import type { Holding13f } from "./form13f";

// 13F-03: the diff engine. Two snapshots we HOLD, nothing else — the
// coverage-guard applied to institutional filings: "Reported in Q1, absent
// from the Q2 filing" is a fact about two documents in our lake; "sold" and
// "first time ever" are claims about the world, and nothing here can license
// them (copy law).

export interface DiffRow {
  cusip: string;
  putCall: string;
  issuer: string;
  status: "NEW" | "EXIT" | "ADD" | "TRIM" | "UNCHANGED";
  valueUsd: number | null;
  shares: number | null;
  prevValueUsd: number | null;
  prevShares: number | null;
  pctOfPortfolio: number | null;
  qoqShareDelta: number;
  qoqShareDeltaPct: number | null;
  qoqValueDeltaUsd: number;
}

/** Round to 2dp for storage; the model receives finished numbers only. */
function pct2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Diff two held snapshots, keyed (cusip, putCall). Every derived figure the
 * copy could ever cite is computed HERE (model-never-does-arithmetic):
 * pct_of_portfolio, share and value deltas, delta pct. NEW rows carry NULL
 * prev_* and a NULL delta pct — a delta over a zero base is not a number,
 * and NULL must never render as one (the null-vs-zero rule).
 */
export function computeDiff(prev: readonly Holding13f[], curr: readonly Holding13f[]): DiffRow[] {
  const key = (h: Holding13f): string => `${h.cusip}|${h.putCall}`;
  const prevBy = new Map(prev.map((h) => [key(h), h]));
  const currBy = new Map(curr.map((h) => [key(h), h]));
  const currTotal = curr.reduce((n, h) => n + h.valueUsd, 0);
  const out: DiffRow[] = [];

  for (const h of curr) {
    const p = prevBy.get(key(h));
    if (!p) {
      out.push({
        cusip: h.cusip, putCall: h.putCall, issuer: h.issuer, status: "NEW",
        valueUsd: h.valueUsd, shares: h.shares, prevValueUsd: null, prevShares: null,
        pctOfPortfolio: currTotal > 0 ? pct2((h.valueUsd / currTotal) * 100) : null,
        qoqShareDelta: h.shares, qoqShareDeltaPct: null, qoqValueDeltaUsd: h.valueUsd,
      });
      continue;
    }
    const status = h.shares === p.shares ? "UNCHANGED" : h.shares > p.shares ? "ADD" : "TRIM";
    out.push({
      cusip: h.cusip, putCall: h.putCall, issuer: h.issuer, status,
      valueUsd: h.valueUsd, shares: h.shares, prevValueUsd: p.valueUsd, prevShares: p.shares,
      pctOfPortfolio: currTotal > 0 ? pct2((h.valueUsd / currTotal) * 100) : null,
      qoqShareDelta: h.shares - p.shares,
      qoqShareDeltaPct: p.shares > 0 ? pct2(((h.shares - p.shares) / p.shares) * 100) : null,
      qoqValueDeltaUsd: h.valueUsd - p.valueUsd,
    });
  }
  for (const p of prev) {
    if (currBy.has(key(p))) continue;
    out.push({
      cusip: p.cusip, putCall: p.putCall, issuer: p.issuer, status: "EXIT",
      valueUsd: null, shares: null, prevValueUsd: p.valueUsd, prevShares: p.shares,
      pctOfPortfolio: null,
      qoqShareDelta: -p.shares, qoqShareDeltaPct: -100, qoqValueDeltaUsd: -p.valueUsd,
    });
  }
  return out;
}

interface FilingRow {
  id: number;
  form: string;
  filed_at: string;
  amendment_type: string | null;
}

/**
 * Resolve the snapshot for (cik, period) with amendment semantics, per the
 * Form 13F amendment model:
 *
 *   - base = the earliest parsed 13F-HR for the period;
 *   - each later 13F-HR/A applies in filed order:
 *       RESTATEMENT   -> replaces the whole table;
 *       anything else -> NEW HOLDINGS: merges (adds rows; replaces on
 *                        (cusip, putCall) collision) — the
 *                        confidential-treatment reveal pattern.
 *
 * Resolution happens at READ time from the stored per-filing holdings —
 * nothing is mutated, so a late amendment cannot corrupt the record it
 * amends, and a recompute is always possible.
 */
export async function snapshotHoldings(env: Env, cik: string, period: string): Promise<Holding13f[] | null> {
  const filings = await env.DB.prepare(
    `SELECT id, form, filed_at, amendment_type FROM filings_13f
     WHERE cik = ?1 AND period = ?2 AND status = 'parsed' AND form IN ('13F-HR', '13F-HR/A')
     ORDER BY filed_at, id`,
  )
    .bind(cik, period)
    .all<FilingRow>();
  if (filings.results.length === 0) return null;

  const loadHoldings = async (filingId: number): Promise<Holding13f[]> => {
    const rows = await env.DB.prepare(
      `SELECT cusip, put_call, issuer, class, value_usd, shares, sh_prn_type, discretion,
              voting_sole, voting_shared, voting_none
       FROM holdings_13f WHERE filing_id = ?1`,
    )
      .bind(filingId)
      .all<{
        cusip: string; put_call: string; issuer: string; class: string | null;
        value_usd: number; shares: number; sh_prn_type: string | null; discretion: string | null;
        voting_sole: number; voting_shared: number; voting_none: number;
      }>();
    return rows.results.map((r) => ({
      cusip: r.cusip, putCall: r.put_call, issuer: r.issuer, cls: r.class ?? "",
      valueUsd: r.value_usd, shares: r.shares, shPrnType: r.sh_prn_type ?? "",
      discretion: r.discretion ?? "", votingSole: r.voting_sole, votingShared: r.voting_shared,
      votingNone: r.voting_none,
    }));
  };

  const base = filings.results.find((f) => f.form === "13F-HR") ?? filings.results[0]!;
  let snapshot = await loadHoldings(base.id);
  for (const f of filings.results) {
    if (f.id === base.id || f.form !== "13F-HR/A") continue;
    const amend = await loadHoldings(f.id);
    if ((f.amendment_type ?? "").toUpperCase() === "RESTATEMENT") {
      snapshot = amend;
    } else {
      const byKey = new Map(snapshot.map((h) => [`${h.cusip}|${h.putCall}`, h]));
      for (const h of amend) byKey.set(`${h.cusip}|${h.putCall}`, h);
      snapshot = [...byKey.values()];
    }
  }
  return snapshot;
}

/**
 * Compute + store the diff for a manager's latest parsed period, and refresh
 * the NEXT period's diff when an amendment lands on a prior one (the diff
 * whose baseline just moved).
 *
 * Coverage guard, structural: a diff exists only between two periods we HOLD
 * parsed snapshots for. No prior period -> no rows -> nothing claimable.
 * 13F-NT filings never parse, so they can never anchor a diff.
 */
export async function runDiffFor(env: Env, cik: string, now: Date = new Date()): Promise<void> {
  const periods = await env.DB.prepare(
    `SELECT DISTINCT period FROM filings_13f
     WHERE cik = ?1 AND status = 'parsed' AND period IS NOT NULL AND form IN ('13F-HR', '13F-HR/A')
     ORDER BY period`,
  )
    .bind(cik)
    .all<{ period: string }>();
  const held = periods.results.map((r) => r.period);
  if (held.length < 2) return; // one snapshot is a photo, not a comparison

  // Recompute every adjacent pair we hold. Idempotent (delete + reinsert per
  // pair), cheap (a watchlist manager holds a handful of quarters), and it
  // makes amendment handling a non-event: whatever period the /A landed on,
  // the pairs it touches are recomputed on the next pass.
  for (let i = 1; i < held.length; i++) {
    const prevPeriod = held[i - 1]!;
    const period = held[i]!;
    const prev = await snapshotHoldings(env, cik, prevPeriod);
    const curr = await snapshotHoldings(env, cik, period);
    if (!prev || !curr) continue;
    const rows = computeDiff(prev, curr);
    const stmts = [
      env.DB.prepare(`DELETE FROM diffs_13f WHERE cik = ?1 AND period = ?2`).bind(cik, period),
      ...rows.map((r) =>
        env.DB.prepare(
          `INSERT INTO diffs_13f
           (cik, period, prev_period, cusip, put_call, issuer, status, value_usd, shares,
            prev_value_usd, prev_shares, pct_of_portfolio, qoq_share_delta, qoq_share_delta_pct,
            qoq_value_delta_usd, computed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        ).bind(
          cik, period, prevPeriod, r.cusip, r.putCall, r.issuer, r.status, r.valueUsd, r.shares,
          r.prevValueUsd, r.prevShares, r.pctOfPortfolio, r.qoqShareDelta, r.qoqShareDeltaPct,
          r.qoqValueDeltaUsd, iso(now),
        ),
      ),
    ];
    await env.DB.batch(stmts);
    log("info", "13F diff computed", { cik, period, prevPeriod, rows: rows.length });
  }
}
