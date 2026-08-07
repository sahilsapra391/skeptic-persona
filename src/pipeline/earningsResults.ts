/**
 * B-04.4: pairing an earnings 8-K with the periodic filing that carries its
 * XBRL. This is the EARNINGS_RESULTS trigger, and it is load-bearing: it
 * decides which structured facts are allowed to be attributed to which
 * announcement. A wrong pair does not produce a missing card, it produces a
 * card whose numbers belong to a different quarter, which is a fabrication.
 *
 * WHAT WENT WRONG THE FIRST TIME (the reason this file exists)
 *
 * The original lag measurement paired "the most recent 8-K before date D" with
 * "the next 10-Q filed after it". Both halves were wrong, and together they
 * manufactured a lag distribution that did not exist:
 *
 *   Mastech Digital   reported as 8-K 2026-05-18 -> 10-Q 2026-08-06,  80d
 *   Airship AI        reported as 8-K 2026-05-11 -> 10-Q 2026-08-06,  87d
 *   Montauk Renewables reported as 8-K 2026-05-28 -> 10-Q 2026-08-05, 69d
 *
 * Checked against SEC submissions, every one is an artifact:
 *
 *   Mastech    filed NO item-2.02 8-K on 05-18 at all. The matcher grabbed an
 *              unrelated 8-K and paired it with the NEXT QUARTER's 10-Q.
 *              The real pair is 8-K 05-15 -> 10-Q 05-15 (period 2026-03-31).
 *   Airship    real pair is 8-K 05-11 -> 10-Q 05-08 (period 2026-03-31). The
 *              periodic landed THREE DAYS BEFORE the 8-K.
 *   Montauk    real pair is 8-K 05-06 -> 10-Q 05-06 (period 2026-03-31).
 *
 * Two rules fall straight out of that, and both are enforced below.
 *
 * 1. MATCH ON THE SPECIFIC 2.02 ACCESSION. An 8-K without item 2.02 is not an
 *    earnings announcement and has no results to pair.
 *
 * 2. MATCH ON PERIOD, NOT ON FILING ORDER. "The next 10-Q filed after the
 *    8-K" is not the 10-Q for the quarter the 8-K announced. The periodic
 *    that belongs to an earnings 8-K is the one whose PERIOD END is the most
 *    recent period ending at or before the announcement, which is a fact
 *    about the fiscal calendar and not about who filed first.
 *
 * Airship is the case that makes rule 2 non-optional: order-based matching
 * cannot express "the periodic arrived first", so it silently reaches forward
 * a whole quarter. The lane must never assume the periodic follows the event.
 *
 * FIELD SEMANTICS, which are the trap underneath all of this. In SEC
 * submissions JSON `reportDate` means different things per form:
 *   - on a 10-Q/10-K it is the PERIOD END the report covers
 *   - on an 8-K it is the EVENT DATE
 * They are never compared as like quantities here.
 */

/** A 10-Q or 10-K, the forms that carry periodic XBRL. */
export interface PeriodicFiling {
  readonly form: string;
  readonly accession: string;
  /** When it was filed. */
  readonly filedIso: string;
  /** `reportDate` on a periodic: the END of the period covered. */
  readonly periodEndIso: string;
}

/** An 8-K carrying item 2.02, results of operations. */
export interface EarningsEvent {
  readonly cik: string;
  readonly accession: string;
  readonly filedIso: string;
  /** `reportDate` on an 8-K: the date of the reported EVENT. */
  readonly eventDateIso: string;
  readonly itemCodes: readonly string[];
}

export interface PairedResults {
  readonly event: EarningsEvent;
  readonly periodic: PeriodicFiling;
  /** `periodic.filedIso - event.filedIso`, in days. NEGATIVE when the
   *  periodic was filed first, which is a real and common case. */
  readonly lagDays: number;
  /** The fiscal period both filings are agreed to be about. */
  readonly periodEndIso: string;
}

/**
 * How far back a period end may sit from the announcement.
 *
 * A quarterly earnings 8-K lands roughly 20-60 days after the quarter closes;
 * an annual one runs longer. 120 days covers the annual case with room and
 * still refuses to reach back a whole extra quarter (which is ~91 days plus
 * the filing delay, so it cannot be silently absorbed).
 *
 * Not a tuned constant, and deliberately not one: it exists to bound a
 * lookup, and any value between roughly 100 and 150 does the same job. It is
 * NOT a claim about typical reporting lag.
 */
export const MAX_PERIOD_AGE_DAYS = 120;

const DAY_MS = 86_400_000;

function dayDiff(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((a - b) / DAY_MS);
}

/** Item 2.02 is "Results of Operations and Financial Condition". */
export function isEarningsEvent(itemCodes: readonly string[]): boolean {
  return itemCodes.includes("2.02");
}

/**
 * Parse SEC submissions `filings.recent` into the two shapes above.
 *
 * Only 2.02 8-Ks and 10-Q/10-K are returned; everything else is not part of
 * this pairing and is dropped rather than carried along to be filtered later.
 */
export function parseSubmissions(
  cik: string,
  rows: ReadonlyArray<{ form?: string; filingDate?: string; reportDate?: string; accessionNumber?: string; items?: string }>,
): { events: EarningsEvent[]; periodics: PeriodicFiling[] } {
  const events: EarningsEvent[] = [];
  const periodics: PeriodicFiling[] = [];
  for (const r of rows) {
    const form = (r.form ?? "").trim();
    const filedIso = (r.filingDate ?? "").trim();
    const reportDate = (r.reportDate ?? "").trim();
    const accession = (r.accessionNumber ?? "").trim();
    if (!form || !filedIso || !accession) continue;

    if (form === "10-Q" || form === "10-K") {
      // A periodic with no period end cannot be matched on period, and
      // matching it any other way is the bug this module exists to prevent.
      if (!reportDate) continue;
      periodics.push({ form, accession, filedIso, periodEndIso: reportDate });
      continue;
    }
    if (form === "8-K") {
      const itemCodes = (r.items ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!isEarningsEvent(itemCodes)) continue;
      // An 8-K's reportDate is the event date. When it is absent, the filing
      // date is the best available stand-in and is never more than a day off.
      events.push({ cik, accession, filedIso, eventDateIso: reportDate || filedIso, itemCodes });
    }
  }
  return { events, periodics };
}

/**
 * The periodic filing that covers the period an earnings 8-K announced.
 *
 * Selection is on PERIOD END, never on filing order:
 *   the latest period ending at or before the event date,
 *   within MAX_PERIOD_AGE_DAYS of it.
 *
 * Returns null when no periodic covers that period yet, which is the ordinary
 * state between an announcement and its 10-Q, not an error.
 */
export function pairPeriodicForEvent(
  event: EarningsEvent,
  periodics: readonly PeriodicFiling[],
  maxPeriodAgeDays: number = MAX_PERIOD_AGE_DAYS,
): PairedResults | null {
  if (!isEarningsEvent(event.itemCodes)) return null;

  let best: PeriodicFiling | null = null;
  for (const p of periodics) {
    const age = dayDiff(event.eventDateIso, p.periodEndIso);
    if (!Number.isFinite(age)) continue;
    // Period must have CLOSED by the announcement. A period ending after the
    // event date cannot be what the event reported on.
    if (age < 0) continue;
    if (age > maxPeriodAgeDays) continue;
    // Latest qualifying period end wins. On a tie, prefer the earlier-filed
    // one so the choice is deterministic rather than input-order dependent.
    if (
      best === null ||
      p.periodEndIso > best.periodEndIso ||
      (p.periodEndIso === best.periodEndIso && p.filedIso < best.filedIso)
    ) {
      best = p;
    }
  }
  if (best === null) return null;

  return {
    event,
    periodic: best,
    lagDays: dayDiff(best.filedIso, event.filedIso),
    periodEndIso: best.periodEndIso,
  };
}

/** Pair every earnings event in a submissions set. Unpaired events drop. */
export function pairAll(
  events: readonly EarningsEvent[],
  periodics: readonly PeriodicFiling[],
  maxPeriodAgeDays: number = MAX_PERIOD_AGE_DAYS,
): PairedResults[] {
  return events
    .map((e) => pairPeriodicForEvent(e, periodics, maxPeriodAgeDays))
    .filter((p): p is PairedResults => p !== null);
}
