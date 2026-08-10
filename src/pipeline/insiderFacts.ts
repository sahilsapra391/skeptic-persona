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
  /**
   * Shares acquired minus shares disposed across the filing. Negative means
   * the holding shrank; ZERO means it closed exactly where it opened.
   *
   * This is what an exercise-and-sell filing has INSTEAD of a percentage.
   * Barrett exercised 293,968 and sold 293,968 the same day: pctDisposed is
   * suppressed because nothing was disposed of on net, and the honest,
   * fully-derived line is that he ended the day on the share count he started
   * it with. 12 of 60 live filings are net-flat or net-positive.
   */
  netShareChange: number | null;
  /** Shares sold under an open-market sale code, as opposed to disposed. */
  sharesSold: number | null;
  /**
   * The closing stake we computed does NOT describe everything the filer
   * holds, because the filing reports a second class, options, RSUs, or a
   * footnoted balance. 22 of 50 live filings carrying a stake are partial.
   */
  stakeIsPartial: boolean;
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
 * Transaction codes that are actually SELLING.
 *
 * `S` is an open-market or private sale. Deliberately nothing else: `F` is
 * securities withheld to cover tax or an exercise price, `G` is a bona fide
 * gift, `D` is a disposition back to the issuer, `J` is "other". Those are all
 * dispositions and none of them is an insider choosing to sell into the
 * market, which is the only thing this desk's primary lane is about.
 */
const SALE_CODES = new Set(["S"]);

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
export function pctDisposedOf(
  txns: readonly Form4Txn[],
  otherHoldingsReported = false,
): { pct: number; sharesAfter: number } | null {
  // INVARIANT 4 (D-131): "% of their stake" needs to be over their STAKE.
  // When the filing also reports holdings we do not aggregate -- a second
  // share class, options, RSUs -- the non-derivative closing balance is one
  // security class and the percentage is over the wrong denominator. Allaire's
  // 8.8% is 8.8% of his Class A and 0.37% of everything the filing reports.
  if (otherHoldingsReported) return null;
  const disposals = txns.filter((t) => t.acquiredDisposed === "D" && num(t.shares));
  const disposed = disposals.reduce((n, t) => n + (t.shares ?? 0), 0);
  const acquired = txns
    .filter((t) => t.acquiredDisposed === "A" && num(t.shares))
    .reduce((n, t) => n + (t.shares ?? 0), 0);
  if (disposed <= 0) return null;

  // INVARIANT 1 (D-130): only an open-market SALE is selling. `F` is shares
  // withheld to pay tax or an exercise price, `G` is a gift, `D` is a
  // disposition back to the issuer. Nine live filings had a disposal total
  // that was 100% F or G; calling those "X% disposed" on a desk whose lane is
  // insider SELLING describes something that did not happen.
  const sold = disposals
    .filter((t) => SALE_CODES.has(t.code.trim().toUpperCase()))
    .reduce((n, t) => n + (t.shares ?? 0), 0);
  if (sold <= 0) return null;

  // INVARIANT 2 (D-130): a holding that did not SHRINK was not disposed of.
  // Twelve live filings acquired at least as much as they disposed -- seven
  // are exercise-plus-withholding where the insider ended up with MORE shares,
  // and three are exercise-and-sell that closed exactly where they opened.
  // Michael Barrett exercised 293,968 and sold 293,968 the same day, ending on
  // 403,074 shares, precisely where he started. The old code called that
  // "42.2% of his stake" because it measured the sale against the balance
  // AFTER the exercise. He sold none of the stake he already had.
  if (acquired >= disposed) return null;

  const remaining = closingStakeOf(txns);
  if (remaining === null) return null;

  // The stake as it stood before the filing, reconstructed rather than
  // assumed: what is left, plus everything that went out, less everything
  // that came in.
  const opening = remaining + disposed - acquired;
  if (opening <= 0) return null;

  // INVARIANT 3 (D-130): a share of a stake is a percentage. Anything outside
  // 0-100 means the reconstruction is wrong, and a wrong reconstruction is
  // suppressed rather than clamped -- clamping to 100 would turn a broken
  // filing into a confident "sold their entire stake".
  const pct = Math.round((sold / opening) * 1000) / 10;
  if (!(pct > 0 && pct <= 100)) return null;
  return { pct, sharesAfter: remaining };
}

/**
 * The stake left when the filing closes: every ownership line's final balance,
 * summed. Null when any line's balance is missing or incoherent.
 *
 * Separate from the percentage on purpose. Barrett's exercise-and-sell has no
 * honest percentage but a perfectly honest closing stake of 403,074 shares,
 * and a beat should be able to print the one without the other.
 */
export function closingStakeOf(txns: readonly Form4Txn[]): number | null {
  // INVARIANT 5 (D-131): a footnoted balance is not a plain share count.
  // Ostling's 4,608 is "2,590 held outright and 2,018 issuable upon vesting of
  // restricted stock units". Printing it as shares kept states 2,018 shares
  // she does not hold.
  if (txns.some((t) => t.sharesAfterFootnoted)) return null;
  // Ownership line = direct/indirect plus the nature text, because a filer can
  // report four separate trusts that are all "I".
  const lines = new Map<string, Form4Txn[]>();
  for (const t of txns) {
    const key = `${t.direct ? "D" : "I"}|${t.natureOfOwnership ?? ""}`;
    lines.set(key, [...(lines.get(key) ?? []), t]);
  }
  if (lines.size === 0) return null;

  let remaining = 0;
  for (const rows of lines.values()) {
    if (!isCoherentBalance(rows)) return null;
    // Document order, NOT date order: rows within a line are already sequenced
    // by the filer, and same-date rows have no date to sort by.
    const last = rows.at(-1);
    if (!last || !num(last.sharesAfter)) return null;
    remaining += last.sharesAfter;
  }
  return remaining;
}

/**
 * Does this ownership line behave like a running balance at all?
 *
 * Two live Clear Secure ($YOU) filings of 2026-08-06, accessions
 * 0001466453-26-000030 (Caryn Seidman Becker) and 0001869246-26-000022
 * (Alclear Investments, LLC), report nine consecutive sales each with
 * `sharesOwnedFollowingTransaction` of 0, then a disposal whose balance RISES
 * to 17,806,342. Read as a running balance that is nonsense, and the
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
  otherHoldingsReported = false,
): InsiderFacts {
  const disposed = pctDisposedOf(txns, otherHoldingsReported);
  const es = exerciseAndSellOf(txns, derivatives);
  const priced = txns.filter((t) => num(t.shares));
  const inShares = priced.filter((t) => t.acquiredDisposed === "A").reduce((n, t) => n + (t.shares ?? 0), 0);
  const outShares = priced.filter((t) => t.acquiredDisposed === "D").reduce((n, t) => n + (t.shares ?? 0), 0);
  const sold = priced
    .filter((t) => t.acquiredDisposed === "D" && SALE_CODES.has(t.code.trim().toUpperCase()))
    .reduce((n, t) => n + (t.shares ?? 0), 0);
  return {
    pctDisposed: disposed?.pct ?? null,
    // The closing stake stands on its own; it does not need the percentage.
    sharesAfter: closingStakeOf(txns),
    netShareChange: priced.length > 0 ? inShares - outShares : null,
    // True when the filing reports positions outside what we counted, so no
    // beat may print a bare "kept N shares" (D-131).
    stakeIsPartial: otherHoldingsReported || txns.some((t) => t.sharesAfterFootnoted),
    sharesSold: sold > 0 ? sold : null,
    planFlag,
    exerciseAndSell: es !== null,
    exerciseSpread: es?.spread ?? null,
    exercisePrice: es?.exercisePrice ?? null,
    lateFiling: lateFilingOf(txns),
    codes: [...new Set(txns.map((t) => t.code).filter((c) => c !== ""))].sort(),
    rowCount: txns.length,
  };
}
