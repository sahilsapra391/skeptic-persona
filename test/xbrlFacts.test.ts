import { describe, expect, it } from "vitest";
import FACTS from "./fixtures/xbrl-companyfacts.json";
import {
  CONCEPT_PRIORITY,
  FIGURE_UNIT,
  companyFactsUrl,
  quarterlyPeriods,
  resolveFigure,
  resolvePeriod,
  type CompanyFacts,
} from "../src/ingesters/xbrlFacts";

// Real companyfacts, trimmed to the concepts the resolver reads and to periods
// ending in 2026. Nothing here is synthetic.
const FIX = FACTS as unknown as Record<string, CompanyFacts>;
const Q2 = { start: "2026-04-01", end: "2026-06-30" };

describe("p5-32: XBRL figures are resolved or omitted, never guessed", () => {
  it("OMITS revenue when the filer's own tags disagree (ENSG, $8.0M apart)", () => {
    // The load-bearing case. Both numbers are ENSG's own tags for the same
    // period, 1,432,497,000 against 1,440,481,000. Picking the higher-priority
    // concept would be an $8M guess about what the filer means by "revenue",
    // and B-01.6 says an ambiguous mapping is omitted, never guessed.
    const r = resolveFigure(FIX.ENSG!, "revenue", Q2.start, Q2.end);
    expect(r.value).toBeNull();
    expect(r.omitted).toBe("concepts-disagree");
    expect(r.reportedBy.length).toBeGreaterThan(1);
  });

  it("KEEPS revenue when two concepts report the same number (MHH)", () => {
    // Two concepts, one value. There is nothing to choose between, so the
    // omit rule must not fire — otherwise it would cost every filer that
    // double-tags, which is common.
    const r = resolveFigure(FIX.MHH!, "revenue", Q2.start, Q2.end);
    expect(r.omitted).toBeNull();
    expect(r.value).toBe(41447000);
    expect(r.reportedBy.length).toBeGreaterThan(1);
    // Attribution goes to the highest-priority concept that reported.
    expect(r.concept).toBe("RevenueFromContractWithCustomerExcludingAssessedTax");
  });

  it("a bank's interest income is NOT relabelled as revenue (LKFN)", () => {
    // LKFN tags InterestAndDividendIncomeOperating and nothing on the accepted
    // list. That is a real figure and a different thing, so the lane omits
    // rather than calling it revenue.
    const r = resolveFigure(FIX.LKFN!, "revenue", Q2.start, Q2.end);
    expect(r.value).toBeNull();
    expect(r.omitted).toBe("no-concept-reported");
    expect(CONCEPT_PRIORITY.revenue).not.toContain("InterestAndDividendIncomeOperating");
  });

  it("aligns on start/end, so a prior-year comparative cannot be read as current (D-50)", () => {
    // AMD's fiscal quarters are not calendar quarters: 2026-03-29..2026-06-27.
    // Asking for the calendar quarter must return nothing rather than the
    // nearest thing, which is what fy/fp keying did.
    const periods = quarterlyPeriods(FIX.AMD!);
    expect(periods.length).toBeGreaterThan(0);
    expect(periods.some((p) => p.endIso === "2026-06-27")).toBe(true);
    // The calendar quarter is NOT one of AMD's periods.
    expect(periods.some((p) => p.startIso === "2026-04-01" && p.endIso === "2026-06-30")).toBe(false);
    expect(resolveFigure(FIX.AMD!, "revenue", "2026-04-01", "2026-06-30").omitted).toBe("no-concept-reported");
    // Its own period resolves cleanly.
    const own = resolveFigure(FIX.AMD!, "revenue", "2026-03-29", "2026-06-27");
    expect(own.omitted).toBeNull();
    expect(own.value).toBe(11536000000);
  });

  it("periods come back newest-first and are all quarter-shaped", () => {
    const periods = quarterlyPeriods(FIX.AMD!);
    for (const p of periods) {
      const days = (Date.parse(p.endIso) - Date.parse(p.startIso)) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(80);
      expect(days).toBeLessThanOrEqual(100);
    }
    const ends = periods.map((p) => p.endIso);
    expect([...ends].sort().reverse()).toEqual(ends);
  });

  it("resolvePeriod carries every figure with its reason", () => {
    const p = resolvePeriod(FIX.ENSG!, Q2.start, Q2.end);
    expect(Object.keys(p.figures).sort()).toEqual(["dilutedEps", "netIncome", "revenue"]);
    // Revenue omitted, but the other two are unaffected: one ambiguous figure
    // must not suppress the whole card.
    expect(p.figures.revenue.omitted).toBe("concepts-disagree");
    expect(p.figures.dilutedEps.value).not.toBeNull();
    for (const f of Object.values(p.figures)) {
      // Every figure is EITHER a value with a concept OR an omission with a
      // reason. Never both, never neither.
      expect(f.value === null).toBe(f.omitted !== null);
      expect(f.value === null ? f.concept === null : f.concept !== null).toBe(true);
    }
  });

  it("EPS is read in USD/shares, not USD", () => {
    // A unit mismatch would silently read a dollar figure as a per-share one.
    expect(FIGURE_UNIT.dilutedEps).toBe("USD/shares");
    expect(FIGURE_UNIT.revenue).toBe("USD");
    const eps = resolveFigure(FIX.MHH!, "dilutedEps", Q2.start, Q2.end);
    if (eps.value !== null) expect(Math.abs(eps.value)).toBeLessThan(1000);
  });

  it("survives an empty or malformed facts document", () => {
    for (const bad of [{}, { facts: {} }, { facts: { "us-gaap": {} } }] as CompanyFacts[]) {
      const r = resolveFigure(bad, "revenue", Q2.start, Q2.end);
      expect(r.value).toBeNull();
      expect(r.omitted).toBe("no-concept-reported");
      expect(quarterlyPeriods(bad)).toEqual([]);
    }
  });

  it("zero-pads the CIK the way the API requires", () => {
    expect(companyFactsUrl("2488")).toBe("https://data.sec.gov/api/xbrl/companyfacts/CIK0000002488.json");
    expect(companyFactsUrl("0000002488")).toBe("https://data.sec.gov/api/xbrl/companyfacts/CIK0000002488.json");
  });
});
