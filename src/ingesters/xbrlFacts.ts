/**
 * p5-32 / B-01.6: filer-tagged XBRL facts, resolved to ONE figure per concept.
 *
 * This is the mapping layer only. It turns SEC `companyfacts` into a small set
 * of licensed numbers for a specific period, or omits them. It does not card,
 * draft or score; those wait on the EARNINGS_RESULTS archetype.
 *
 * THREE RULES, EACH BOUGHT WITH A MEASUREMENT.
 *
 * 1. ALIGN ON `start`/`end`, NEVER `fy`/`fp` (D-50). Those label the FILING
 *    that reported a fact, not the period it covers. Measured on AMD: two
 *    facts both labelled `fy2026 Q2` cover 2025-03-30..2025-06-28 and
 *    2026-03-29..2026-06-27, because the prior-year comparative carries the
 *    current filing's label. Keying on `fy`/`fp` compares a period against
 *    itself or picks arbitrarily.
 *
 * 2. A DISAGREEMENT IS AN OMISSION, not a tie-break. B-01.6 says an ambiguous
 *    mapping is OMITTED, never guessed, and the live data says this is not
 *    hypothetical. Measured 2026-08-07 for the quarter 2026-04-01..2026-06-30:
 *
 *      ENSG  RevenueFromContractWithCustomer...  1,432,497,000
 *            Revenues                            1,440,481,000   <- $8.0M apart
 *      MHH   both concepts                          41,447,000   <- agree
 *
 *    Both ENSG numbers are the filer's own tags for the same period. Choosing
 *    one is an $8M guess about what the filer means by "revenue", so the field
 *    is dropped. MHH keeps its figure because there is nothing to choose
 *    between. Cost measured across 8 issuers: 1 loses revenue.
 *
 * 3. A BANK'S INTEREST INCOME IS NOT "REVENUE". LKFN tags only
 *    `InterestAndDividendIncomeOperating`, which is a real figure and a
 *    different thing. It is absent from the accepted list on purpose, so the
 *    lane omits rather than relabels.
 *
 * SEGMENTS ARE OUT OF SCOPE (D-51): `companyconcept` and `companyfacts` carry
 * no dimension information at all, verified by inspecting the full key set of
 * every AMD revenue fact. "Data center up 107%" cannot come from here.
 */

/** Figures the desk is willing to state. Deliberately three. */
export type FigureKey = "revenue" | "dilutedEps" | "netIncome";

/**
 * Concept priority per figure, most-standard first.
 *
 * Priority resolves WHICH concept to read. It never resolves a disagreement
 * between two concepts that both reported: see rule 2 above.
 */
export const CONCEPT_PRIORITY: Record<FigureKey, readonly string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "SalesRevenueServicesNet",
  ],
  dilutedEps: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
};

/** The unit each figure must be reported in. A mismatch is dropped. */
export const FIGURE_UNIT: Record<FigureKey, string> = {
  revenue: "USD",
  dilutedEps: "USD/shares",
  netIncome: "USD",
};

export interface XbrlFact {
  readonly start?: string;
  readonly end?: string;
  readonly val?: number;
  readonly form?: string;
  readonly accn?: string;
}

export interface CompanyFacts {
  readonly facts?: { readonly "us-gaap"?: Record<string, { readonly units?: Record<string, readonly XbrlFact[]> }> };
}

export type OmitReason = "no-concept-reported" | "concepts-disagree" | "no-fact-for-period";

export interface ResolvedFigure {
  readonly key: FigureKey;
  readonly value: number | null;
  /** Which concept supplied it. Null when omitted. */
  readonly concept: string | null;
  /** Why it is absent. Null when present. */
  readonly omitted: OmitReason | null;
  /** Every concept that reported for this period, for audit. */
  readonly reportedBy: readonly string[];
}

/** Facts for one concept whose period matches EXACTLY (D-50). */
function factsForPeriod(
  cf: CompanyFacts,
  concept: string,
  unit: string,
  startIso: string,
  endIso: string,
): number[] {
  const units = cf.facts?.["us-gaap"]?.[concept]?.units;
  const arr = units?.[unit];
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  for (const f of arr) {
    if (f.start !== startIso || f.end !== endIso) continue;
    if (typeof f.val !== "number") continue;
    out.push(f.val);
  }
  return out;
}

/**
 * Resolve one figure for one exact period.
 *
 * Returns a value only when every accepted concept that reported for the
 * period agrees. Anything else is an omission carrying its reason.
 */
export function resolveFigure(cf: CompanyFacts, key: FigureKey, startIso: string, endIso: string): ResolvedFigure {
  const unit = FIGURE_UNIT[key];
  const reported: Array<{ concept: string; values: number[] }> = [];
  for (const concept of CONCEPT_PRIORITY[key]) {
    const values = factsForPeriod(cf, concept, unit, startIso, endIso);
    if (values.length > 0) reported.push({ concept, values });
  }
  if (reported.length === 0) {
    return { key, value: null, concept: null, omitted: "no-concept-reported", reportedBy: [] };
  }
  const names = reported.map((r) => r.concept);
  // Every value from every reporting concept, deduped. One survivor means the
  // filer's own tags agree and the figure is safe to state.
  const distinct = [...new Set(reported.flatMap((r) => r.values))];
  if (distinct.length > 1) {
    return { key, value: null, concept: null, omitted: "concepts-disagree", reportedBy: names };
  }
  // Attribution goes to the HIGHEST-PRIORITY concept that reported it, which
  // is the first in `reported` because CONCEPT_PRIORITY drives the loop.
  return { key, value: distinct[0]!, concept: names[0]!, omitted: null, reportedBy: names };
}

export interface PeriodFigures {
  readonly startIso: string;
  readonly endIso: string;
  readonly figures: Record<FigureKey, ResolvedFigure>;
}

export function resolvePeriod(cf: CompanyFacts, startIso: string, endIso: string): PeriodFigures {
  return {
    startIso,
    endIso,
    figures: {
      revenue: resolveFigure(cf, "revenue", startIso, endIso),
      dilutedEps: resolveFigure(cf, "dilutedEps", startIso, endIso),
      netIncome: resolveFigure(cf, "netIncome", startIso, endIso),
    },
  };
}

/**
 * The quarterly periods this filer has actually reported, newest first.
 *
 * Derived from the facts themselves rather than from a fiscal calendar,
 * because filer quarters are not calendar quarters: AMD's Q2 runs
 * 2026-03-29..2026-06-27 (D-50). A window of 80-100 days is what "a quarter"
 * means here, measured rather than assumed.
 */
export function quarterlyPeriods(cf: CompanyFacts, key: FigureKey = "revenue"): Array<{ startIso: string; endIso: string }> {
  const seen = new Set<string>();
  const out: Array<{ startIso: string; endIso: string }> = [];
  const unit = FIGURE_UNIT[key];
  for (const concept of CONCEPT_PRIORITY[key]) {
    const arr = cf.facts?.["us-gaap"]?.[concept]?.units?.[unit];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      if (!f.start || !f.end) continue;
      const days = (Date.parse(f.end) - Date.parse(f.start)) / 86_400_000;
      if (!(days >= 80 && days <= 100)) continue;
      const k = `${f.start}|${f.end}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ startIso: f.start, endIso: f.end });
    }
  }
  return out.sort((a, b) => (a.endIso < b.endIso ? 1 : -1));
}

/** `data.sec.gov` companyfacts for a CIK. Zero-padded, as the API requires. */
export function companyFactsUrl(cik: string): string {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(Number(cik)).padStart(10, "0")}.json`;
}
