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
  /**
   * TRUE when a row declared itself late, NULL when no row declared anything.
   *
   * Nullable for the same reason planLanguage returns null: `false` would
   * assert the filing was TIMELY, and an empty element asserts nothing. See
   * lateFilingOf for why this is not a hypothetical.
   */
  lateFiling: boolean | null;
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
 * Percentage of the stake disposed. THE HEADLINE NUMBER OF THE PRIMARY LANE,
 * and the one that has to be right or not printed at all.
 *
 * disposed / (disposed + remaining), reconstructing the prior balance rather
 * than assuming one. Only DISPOSALS: the same arithmetic on an acquisition
 * answers a different question and would read as a sale.
 *
 * D-129, MEASURED ON 60 LIVE FILINGS, 4 OF 44 WRONG AND WRONG BOTH WAYS.
 * `sharesOwnedFollowingTransaction` is a running balance PER OWNERSHIP LINE,
 * not per filing. Jeremy Allaire's 2026-08-05 Circle filing carries 25 rows
 * across FIVE lines -- direct plus four named trusts -- and taking "the last
 * row's balance" as the stake reported 50.2% disposed where the truth summed
 * across lines is 8.8%. The inputs all parsed correctly; the derivation over
 * them was wrong. Nothing in a green suite could see it.
 *
 * So: group by line, take each line's FINAL balance (whether or not that row
 * is a disposal), and sum. A line whose final balance did not parse voids the
 * whole number -- a stake missing one of five lines is not a stake.
 */
export function pctDisposedOf(txns: readonly Form4Txn[]): { pct: number; sharesAfter: number } | null {
  const disposed = txns
    .filter((t) => t.acquiredDisposed === "D" && num(t.shares))
    .reduce((n, t) => n + (t.shares ?? 0), 0);
  if (disposed <= 0) return null;

  // Ownership line = direct/indirect plus the nature text, because a filer can
  // report four separate trusts that are all "I".
  const lines = new Map<string, Form4Txn[]>();
  for (const t of txns) {
    const key = `${t.direct ? "D" : "I"}|${t.natureOfOwnership ?? ""}`;
    lines.set(key, [...(lines.get(key) ?? []), t]);
  }

  let remaining = 0;
  for (const rows of lines.values()) {
    if (!isCoherentBalance(rows)) return null;
    // Document order, NOT date order: rows within a line are already sequenced
    // by the filer, and same-date rows have no date to sort by.
    const last = rows.at(-1);
    if (!last || !num(last.sharesAfter)) return null;
    remaining += last.sharesAfter;
  }

  const prior = remaining + disposed;
  if (prior <= 0) return null;
  return { pct: Math.round((disposed / prior) * 1000) / 10, sharesAfter: remaining };
}

/**
 * Does this ownership line behave like a running balance at all?
 *
 * Two live filings (Bullish, 2026-08-06) report nine consecutive sales each
 * with `sharesOwnedFollowingTransaction` of 0, then a disposal whose balance
 * RISES to 17,806,342. Read as a running balance that is nonsense, and the
 * arithmetic over it produced 3.5% one way and 81.0% the other -- two wrong
 * answers, no right one available.
 *
 * A disposal cannot increase a balance. When one does, the column is not a
 * running balance in this filing and NOTHING derived from it may be printed.
 * The correct output for these filings is no percentage, not a better guess.
 */
function isCoherentBalance(rows: readonly Form4Txn[]): boolean {
  let prev: number | null = null;
  for (const t of rows) {
    const after = num(t.sharesAfter) ? t.sharesAfter : null;
    if (after !== null && prev !== null && t.acquiredDisposed === "D" && after > prev) return false;
    if (after !== null) prev = after;
  }
  return true;
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

/**
 * Late-filing marker, and A WORKED EXAMPLE OF PRESENCE-IS-NOT-A-VALUE (D-128).
 *
 * `L` is the SEC's own late marker. Returns true only when a row carries it,
 * and NULL when no row carries any timeliness value at all -- because `false`
 * would assert the filing was timely, which an empty element does not say.
 * Same doctrine as planLanguage: absence licenses nothing in either direction.
 *
 * MEASURED, and this is why the field is nullable rather than boolean. Across
 * 60 live Form 4s: 15 filings contain `<transactionTimeliness>`, all 34
 * occurrences are EMPTY (`<transactionTimeliness></transactionTimeliness>`),
 * and 0 carry any content. I originally shipped this as a plain boolean with a
 * comment reading "15 of 60 live filings carry it" -- I had counted the
 * element's PRESENCE and written it down as its MEANING. The parse was correct
 * the whole time; the claim about it was not.
 *
 * SO NO BEAT MAY GATE ON THIS YET. On today's data it is true 0 times out of
 * 60 and a beat reading it would be dead code that looks live. It stays parsed
 * because it costs nothing and the marker does appear in the wild; it does not
 * become copy until a filing actually carries an `L`.
 */
export function lateFilingOf(txns: readonly Form4Txn[]): boolean | null {
  const stated = txns.map((t) => (t.timeliness ?? "").trim()).filter((v) => v !== "");
  if (stated.length === 0) return null;
  return stated.some((v) => v.toUpperCase() === "L");
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
    lateFiling: lateFilingOf(txns),
    codes: [...new Set(txns.map((t) => t.code).filter((c) => c !== ""))].sort(),
    rowCount: txns.length,
  };
}
