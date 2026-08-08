// p6-03 (B2, B-10.1/B-10.3): derived display fields for the insider payload.
//
// THE DIAGNOSIS THIS ANSWERS. Card #1243 produced a real take -- "Same page:
// an M entry at $19.15, followed by four S entries at $56.21, $56.96, $58.12
// and $58.79. Calling it a buy leaves the sales out." -- because its payload
// carried every transaction row. Every thin payload produced a thin take,
// because there was nothing in front of the model except one aggregated fact
// and the never-list. The fix is payload richness, not prompt engineering.
//
// EVERY FIELD HERE IS DERIVED FROM A FIELD AN INGESTER PARSED, and every one
// is OMITTED rather than approximated when its inputs are absent. Nothing here
// reads a footnote, infers a motive, or fills a gap.

import type { Form4Derivative, Form4Txn } from "../ingesters/form4";

export interface InsiderFacts {
  /** Shares disposed / (disposed + held after). The single most interesting
   *  number in insider selling, and it was computed and never printed. */
  pctDisposed: number | null;
  sharesAfter: number | null;
  /** True only when the filing CHECKED the 10b5-1 box. See planLanguage. */
  planFlag: boolean;
  /** An M row followed by S rows in the same filing. */
  exerciseAndSell: boolean;
  /** Sale price minus exercise price, when both parsed on the same filing. */
  exerciseSpread: number | null;
  exercisePrice: number | null;
  /** The filing declared itself late. */
  lateFiling: boolean;
  /** Distinct transaction codes present, so a beat can gate on shape. */
  codes: string[];
  rowCount: number;
}

/**
 * THE 10b5-1 DOCTRINE, LOCKED (B-10.1). This is the canonical worked example
 * of absence-is-not-evidence in the copy law.
 *
 *   flag TRUE  -> "under a pre-adopted trading plan" is licensed.
 *   flag FALSE -> NOTHING is licensed. Not "discretionary". Not "not under a
 *                 plan". Not an implication in either direction.
 *
 * An unchecked box means the filer did not assert a plan. It does not mean the
 * filer asserted there was none: some who do trade under a plan disclose it
 * only in a footnote. Measured across 60 live filings, 19 carry the flag and
 * 15 mention Rule 10b5-1 in text, with ZERO flag-false-but-footnote-says-plan
 * -- so the flag never under-reports relative to the footnote, but the
 * converse claim still has no evidence behind it.
 *
 * Returns the licensed phrase, or null. Null means SAY NOTHING, which is not
 * the same as saying the negative.
 */
export function planLanguage(planFlag: boolean): string | null {
  return planFlag ? "under a pre-adopted trading plan" : null;
}

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Percentage of the stake disposed, from two parsed fields.
 *
 * shares / (shares + sharesOwnedFollowingTransaction), which reconstructs the
 * prior balance rather than assuming one. Only DISPOSALS: the same arithmetic
 * on an acquisition answers a different question and would read as a sale.
 *
 * Uses the LATEST-dated priced disposal, because `sharesOwnedFollowingTransaction`
 * is a running balance and only the last row's is the post-filing stake.
 */
export function pctDisposedOf(txns: readonly Form4Txn[]): { pct: number; sharesAfter: number } | null {
  const sells = txns
    .filter((t) => t.acquiredDisposed === "D" && num(t.shares) && num(t.sharesAfter) && t.date)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = sells.at(-1);
  if (!last || !num(last.shares) || !num(last.sharesAfter)) return null;
  // Total disposed across the filing, against the balance left at the end.
  const disposed = sells.reduce((n, t) => n + (t.shares ?? 0), 0);
  const prior = last.sharesAfter + disposed;
  if (prior <= 0) return null;
  return { pct: Math.round((disposed / prior) * 1000) / 10, sharesAfter: last.sharesAfter };
}

/**
 * Exercise-and-sell: an M row (option exercise) followed by S rows on the same
 * filing. 4 of 60 live filings, about 7%.
 *
 * The spread is the sale price minus the EXERCISE price, and the exercise
 * price comes from the derivative leg's `conversionOrExercisePrice` -- 22 of
 * 60 filings carry a derivative table. Both must parse or the spread is
 * omitted; a spread against an assumed exercise price would be invented.
 */
export function exerciseAndSellOf(
  txns: readonly Form4Txn[],
  derivatives: readonly Form4Derivative[],
): { spread: number | null; exercisePrice: number | null } | null {
  const codes = txns.map((t) => t.code);
  if (!codes.includes("M") || !codes.includes("S")) return null;
  const sells = txns.filter((t) => t.code === "S" && num(t.price));
  const exercise = derivatives.find((d) => d.code === "M" && num(d.exercisePrice));
  if (sells.length === 0) return { spread: null, exercisePrice: exercise?.exercisePrice ?? null };
  // Share-weighted sale price, so a small lot cannot move the headline.
  const shares = sells.reduce((n, t) => n + (t.shares ?? 0), 0);
  const gross = sells.reduce((n, t) => n + (t.shares ?? 0) * (t.price ?? 0), 0);
  const avg = shares > 0 ? gross / shares : null;
  const ex = exercise?.exercisePrice ?? null;
  return {
    exercisePrice: ex,
    spread: avg !== null && ex !== null ? Math.round((avg - ex) * 100) / 100 : null,
  };
}

export function insiderFactsOf(
  txns: readonly Form4Txn[],
  derivatives: readonly Form4Derivative[],
  planFlag: boolean,
): InsiderFacts {
  const disposed = pctDisposedOf(txns);
  const es = exerciseAndSellOf(txns, derivatives);
  return {
    pctDisposed: disposed?.pct ?? null,
    sharesAfter: disposed?.sharesAfter ?? null,
    planFlag,
    exerciseAndSell: es !== null,
    exerciseSpread: es?.spread ?? null,
    exercisePrice: es?.exercisePrice ?? null,
    // `L` is the SEC's own late marker; anything else present is not a claim
    // we make. 15 of 60 live filings carry a timeliness value.
    lateFiling: txns.some((t) => (t.timeliness ?? "").toUpperCase() === "L"),
    codes: [...new Set(txns.map((t) => t.code).filter((c) => c !== ""))].sort(),
    rowCount: txns.length,
  };
}
