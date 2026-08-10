// p6-03 (B2, B-32.6): prior-transaction context for an insider, from our own
// lake, under the coverage guard.
//
// WHAT THIS IS FOR. A single Form 4 says what happened once. "Her fourth sale
// since May" says what is happening, and that is the take the primary lane
// exists to produce. The lake already holds it: `insider_trades` carries one
// row per transaction with side, shares, price and date, keyed on insider and
// issuer CIK.
//
// WHY MOST OF IT WILL RETURN NULL TODAY, AND WHY THAT IS CORRECT.
// A count is a claim about a WINDOW. Saying "her fourth sale since May" asserts
// we could have seen a fifth in June and did not. We began ingesting
// edgar_form4 on 2026-07-27, so as of this writing the window we can honestly
// speak about is about two weeks long, and every longer window is suppressed.
//
// The lake's own MIN(transaction_date) is 2024-08-12 and IT MUST NOT BE USED
// AS COVERAGE (D-128, presence is not semantics). That row exists because one
// late-filed 2024 transaction arrived inside our recent window. The real
// distribution: 8,507 of 8,662 rows are July and August 2026, and 2024-08 has
// exactly one row. The minimum date is a real value that means nothing about
// what we can see. Coverage opens where OBSERVATION opened, never where the
// oldest straggler happens to sit.
//
// p6-07's 24-month backfill is what turns these fields on. Until it lands the
// gates simply never match and no beat can state a count, which is the same
// mechanism edgar8k uses and the same reason.

import { coverageFor } from "../lookback";

/** Sale codes, matching insiderFacts: only an open-market sale is selling. */
const SALE_SIDE = "sell";

export interface InsiderLakeContext {
  /** Prior SALE filings by this insider at this issuer inside the window. */
  priorSales: number | null;
  priorSaleShares: number | null;
  /** ISO date of the most recent prior sale, when one is inside the window. */
  lastSaleDate: string | null;
  /** Distinct months in the window carrying a sale, i.e. how sustained it is. */
  activeMonths: number | null;
  /** Always present, so the ledger records WHY a count is absent. */
  coverageDays: number | null;
  windowDays: number;
  covered: boolean;
}

export interface LakeContextInput {
  insiderCik: string;
  issuerCik: string;
  /** ISO date-time the window opens at. */
  since: string;
  /** The item being rendered, excluded so it cannot count itself. */
  excludeItemId?: number;
  source: string;
}

/**
 * Prior-sale context for one insider at one issuer.
 *
 * NEVER THROWS AND NEVER PARTIALLY REPORTS. Either the window is covered and
 * every count is populated, or none of them are. A half-populated context
 * would let a beat gate on `priorSales` while `activeMonths` was silently
 * absent for a different reason, which is the shape D-102 warns about.
 */
export async function insiderLakeContextFor(
  db: D1Database,
  input: LakeContextInput,
  now: Date = new Date(),
): Promise<InsiderLakeContext> {
  const windowDays = Math.max(1, Math.ceil((now.getTime() - Date.parse(input.since)) / 86_400_000));
  const coverage = await coverageFor(db, input.source, now);
  const coverageDays = coverage.observedFrom === null ? null : coverage.days;
  const covered = coverageDays !== null && coverageDays >= windowDays;

  const bare: InsiderLakeContext = {
    priorSales: null,
    priorSaleShares: null,
    lastSaleDate: null,
    activeMonths: null,
    coverageDays,
    windowDays,
    covered,
  };
  // The guard runs BEFORE the query, so an uncovered window costs no D1 read
  // on the hottest lane in the pipeline.
  if (!covered) return bare;

  const row = await db
    .prepare(
      `SELECT COUNT(*)                          AS n,
              COALESCE(SUM(shares), 0)          AS shares,
              MAX(transaction_date)             AS last_date,
              COUNT(DISTINCT substr(transaction_date, 1, 7)) AS months
         FROM insider_trades
        WHERE insider_cik = ?1
          AND issuer_cik = ?2
          AND side = ?3
          AND is_amendment = 0
          AND transaction_date >= ?4
          AND (?5 IS NULL OR item_id != ?5)`,
    )
    .bind(input.insiderCik, input.issuerCik, SALE_SIDE, input.since.slice(0, 10), input.excludeItemId ?? null)
    .first<{ n: number; shares: number; last_date: string | null; months: number }>();

  if (!row || row.n === 0) return bare;
  return {
    ...bare,
    priorSales: row.n,
    priorSaleShares: row.shares > 0 ? row.shares : null,
    lastSaleDate: row.last_date,
    activeMonths: row.months,
  };
}

export interface Notice144Link {
  /** Form 4 sale rows already in the lake for this seller at this issuer. */
  priorForm4Sales: number;
  priorForm4Shares: number | null;
  lastForm4SaleDate: string | null;
}

/**
 * Link a Form 144 notice to the seller's Form 4 record at the same issuer.
 *
 * THE JOIN KEY IS VERIFIED, NOT ASSUMED (2026-08-08). A Form 144's top-level
 * `<cik>` is the SELLER's CIK, the same identity Form 4 reports as
 * `rptOwnerCik` -- so `(insider_cik, issuer_cik)` joins the two forms
 * directly. Tested against 25 live Form 144s: 3 of 24 distinct sellers already
 * had Form 4 rows in the lake under exactly that pair, and the match is
 * semantic and not just key equality. Sasha Quinton filed a Scholastic notice
 * with an approximate sale date of 2026-08-07 while the lake held her Form 4
 * exercise-and-sells of 2026-08-05 and 2026-08-06 at the same issuer.
 *
 * 3 of 24 is the honest hit rate at two weeks of coverage, not a bug: a 144 is
 * a notice of INTENT and its Form 4 lands days later, so most notices in any
 * recent sample have no counterpart yet.
 *
 * NOT COVERAGE-GUARDED, and deliberately. This does not claim a count over a
 * window; it reports rows we hold. "We already have three Form 4 sales from
 * her" is true regardless of how far back we can see, where "her fourth sale
 * this year" is not. Distinguishing those two is the whole point of the guard.
 */
export async function notice144LinkFor(
  db: D1Database,
  input: { sellerCik: string; issuerCik: string },
): Promise<Notice144Link | null> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)                 AS n,
              COALESCE(SUM(shares), 0) AS shares,
              MAX(transaction_date)    AS last_date
         FROM insider_trades
        WHERE insider_cik = ?1 AND issuer_cik = ?2 AND side = ?3 AND is_amendment = 0`,
    )
    .bind(input.sellerCik, input.issuerCik, SALE_SIDE)
    .first<{ n: number; shares: number; last_date: string | null }>();
  if (!row || row.n === 0) return null;
  return {
    priorForm4Sales: row.n,
    priorForm4Shares: row.shares > 0 ? row.shares : null,
    lastForm4SaleDate: row.last_date,
  };
}

/**
 * The payload fields, shaped so an absent count is ABSENT rather than null.
 *
 * Same contract as edgar8k's item counts: the keys do not appear at all when
 * the window is uncovered, so a gate like `gte priorSales 3` cannot match and
 * no beat can state a count. Coverage always rides along so the ledger can
 * answer "why was this card thin" without re-running anything.
 */
export function lakeContextFields(ctx: InsiderLakeContext): Record<string, unknown> {
  return {
    lookbackCoverageDays: ctx.coverageDays,
    lookbackWindowDays: ctx.windowDays,
    ...(ctx.covered && ctx.priorSales !== null
      ? {
          priorSales: ctx.priorSales,
          ...(ctx.priorSaleShares !== null ? { priorSaleShares: ctx.priorSaleShares } : {}),
          ...(ctx.lastSaleDate !== null ? { lastSaleDate: ctx.lastSaleDate } : {}),
          ...(ctx.activeMonths !== null ? { activeMonths: ctx.activeMonths } : {}),
          // The occurrence including this filing, which is what copy says:
          // three priors makes this the fourth.
          saleOccurrence: ctx.priorSales + 1,
        }
      : {}),
  };
}
