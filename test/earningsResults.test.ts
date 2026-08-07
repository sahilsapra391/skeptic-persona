import { describe, expect, it } from "vitest";
import SUBMISSIONS from "./fixtures/sec-submissions-earnings.json";
import {
  MAX_PERIOD_AGE_DAYS,
  isEarningsEvent,
  pairAll,
  pairPeriodicForEvent,
  parseSubmissions,
  type PeriodicFiling,
} from "../src/pipeline/earningsResults";

type Fixture = Record<string, { name: string; cik: string; rows: Array<Record<string, string>> }>;
const FIX = SUBMISSIONS as unknown as Fixture;

const parseFor = (cik: string) => parseSubmissions(cik, FIX[cik]!.rows);

describe("B-04.4: the three cases the old matcher got wrong", () => {
  // These are not synthetic. They are the live SEC submissions rows for the
  // three companies the first lag measurement reported as 69-87 day lags.
  // Every one of those was an artifact of pairing on filing ORDER instead of
  // on PERIOD, and each is asserted here at its true value.

  it("Mastech Digital: 8-K 05-15 pairs with the SAME-DAY 10-Q, not the next quarter's", () => {
    // Reported as "8-K 2026-05-18 -> 10-Q 2026-08-06, 80d". Mastech filed no
    // item-2.02 8-K on 05-18 at all; the old matcher took an unrelated 8-K and
    // reached forward a whole quarter.
    const { events, periodics } = parseFor("1437226");
    const may = events.find((e) => e.filedIso === "2026-05-15")!;
    expect(may).toBeDefined();

    const paired = pairPeriodicForEvent(may, periodics)!;
    expect(paired.periodEndIso).toBe("2026-03-31");
    expect(paired.periodic.filedIso).toBe("2026-05-15");
    expect(paired.lagDays).toBe(0);
    // The specific wrong answer must not come back.
    expect(paired.periodic.filedIso).not.toBe("2026-08-06");
  });

  it("Airship AI: the periodic was filed BEFORE the 8-K, so the lag is negative", () => {
    // Reported as 87d. The Q1 10-Q was filed 05-08, three days BEFORE the
    // 05-11 earnings 8-K. Order-based matching cannot express this at all,
    // which is why it silently reached forward to August.
    const { events, periodics } = parseFor("1842566");
    const may = events.find((e) => e.filedIso === "2026-05-11")!;
    const paired = pairPeriodicForEvent(may, periodics)!;

    expect(paired.periodEndIso).toBe("2026-03-31");
    expect(paired.periodic.filedIso).toBe("2026-05-08");
    expect(paired.lagDays).toBe(-3);
    expect(paired.lagDays).toBeLessThan(0);
  });

  it("Montauk Renewables: same-day pair, and the March 8-K takes the 10-K", () => {
    // Reported as 69d. Also covers the annual case: the 03-12 8-K announces
    // FY2025 and must take the 10-K for period 2025-12-31, not a 10-Q.
    const { events, periodics } = parseFor("1826600");

    const may = events.find((e) => e.filedIso === "2026-05-06")!;
    const mayPair = pairPeriodicForEvent(may, periodics)!;
    expect(mayPair.periodEndIso).toBe("2026-03-31");
    expect(mayPair.lagDays).toBe(0);

    const march = events.find((e) => e.filedIso === "2026-03-12")!;
    const marchPair = pairPeriodicForEvent(march, periodics)!;
    expect(marchPair.periodEndIso).toBe("2025-12-31");
    expect(marchPair.periodic.form).toBe("10-K");
  });

  it("no pairing anywhere in the fixture exceeds a quarter", () => {
    // The distribution claim itself, asserted. If a future change reintroduces
    // order-based matching, some pair goes to ~70-90 days and this fails.
    for (const cik of Object.keys(FIX)) {
      const { events, periodics } = parseFor(cik);
      for (const p of pairAll(events, periodics)) {
        expect(Math.abs(p.lagDays)).toBeLessThan(60);
      }
    }
  });
});

describe("B-04.4: matcher rules", () => {
  const periodics: PeriodicFiling[] = [
    { form: "10-K", accession: "a-2025q4", filedIso: "2026-03-01", periodEndIso: "2025-12-31" },
    { form: "10-Q", accession: "a-2026q1", filedIso: "2026-05-10", periodEndIso: "2026-03-31" },
    { form: "10-Q", accession: "a-2026q2", filedIso: "2026-08-06", periodEndIso: "2026-06-30" },
  ];
  const ev = (filedIso: string, eventDateIso: string, itemCodes: string[] = ["2.02"]) => ({
    cik: "1",
    accession: `8k-${filedIso}`,
    filedIso,
    eventDateIso,
    itemCodes,
  });

  it("an 8-K without item 2.02 is not an earnings event and never pairs", () => {
    expect(isEarningsEvent(["5.02", "9.01"])).toBe(false);
    expect(pairPeriodicForEvent(ev("2026-05-15", "2026-05-15", ["5.02", "9.01"]), periodics)).toBeNull();
  });

  it("picks the latest period ENDING BEFORE the event, not the next one filed", () => {
    // The Q2 10-Q is filed later, but on 05-15 the period it covers has not
    // closed. Order says Q2; period says Q1. Period wins.
    const p = pairPeriodicForEvent(ev("2026-05-15", "2026-05-15"), periodics)!;
    expect(p.periodEndIso).toBe("2026-03-31");
    expect(p.periodic.accession).toBe("a-2026q1");
  });

  it("refuses a period that has not closed by the event date", () => {
    // Announcing on 04-01 cannot be about a period ending 06-30.
    const p = pairPeriodicForEvent(ev("2026-04-01", "2026-04-01"), periodics)!;
    expect(p.periodEndIso).toBe("2026-03-31");
  });

  it("returns null rather than reaching back a stale quarter", () => {
    // An event far past every known period end has no honest pair. Silence is
    // the correct output; a stale period would be numbers from the wrong
    // quarter attributed to this announcement.
    expect(pairPeriodicForEvent(ev("2027-06-01", "2027-06-01"), periodics)).toBeNull();
  });

  it("bounds the reach at MAX_PERIOD_AGE_DAYS", () => {
    const justInside = pairPeriodicForEvent(ev("2026-10-20", "2026-10-20"), periodics);
    expect(justInside?.periodEndIso).toBe("2026-06-30");
    // 2026-06-30 + 121d = 2026-10-29.
    expect(pairPeriodicForEvent(ev("2026-10-30", "2026-10-30"), periodics)).toBeNull();
    expect(MAX_PERIOD_AGE_DAYS).toBe(120);
  });

  it("drops a periodic with no period end instead of guessing one", () => {
    const { periodics: parsed } = parseSubmissions("1", [
      { form: "10-Q", filingDate: "2026-05-10", reportDate: "", accessionNumber: "x" },
      { form: "10-Q", filingDate: "2026-05-10", reportDate: "2026-03-31", accessionNumber: "y" },
    ]);
    expect(parsed.map((p) => p.accession)).toEqual(["y"]);
  });

  it("is deterministic when two periodics share a period end", () => {
    // An amended filing can duplicate a period. Earlier-filed wins, so the
    // answer does not depend on the order SEC happened to return rows in.
    const dupes: PeriodicFiling[] = [
      { form: "10-Q", accession: "late", filedIso: "2026-05-20", periodEndIso: "2026-03-31" },
      { form: "10-Q", accession: "early", filedIso: "2026-05-10", periodEndIso: "2026-03-31" },
    ];
    expect(pairPeriodicForEvent(ev("2026-05-25", "2026-05-25"), dupes)?.periodic.accession).toBe("early");
    expect(pairPeriodicForEvent(ev("2026-05-25", "2026-05-25"), [...dupes].reverse())?.periodic.accession).toBe("early");
  });

  it("parseSubmissions keeps only 2.02 8-Ks and periodics", () => {
    const { events, periodics: p } = parseSubmissions("1", [
      { form: "8-K", filingDate: "2026-05-15", reportDate: "2026-05-15", accessionNumber: "a", items: "2.02,9.01" },
      { form: "8-K", filingDate: "2026-05-16", reportDate: "2026-05-16", accessionNumber: "b", items: "5.02" },
      { form: "10-Q", filingDate: "2026-05-15", reportDate: "2026-03-31", accessionNumber: "c" },
      { form: "4", filingDate: "2026-05-15", reportDate: "2026-05-15", accessionNumber: "d" },
      { form: "S-1", filingDate: "2026-05-15", reportDate: "", accessionNumber: "e" },
    ]);
    expect(events.map((e) => e.accession)).toEqual(["a"]);
    expect(p.map((x) => x.accession)).toEqual(["c"]);
  });

  it("falls back to the filing date when an 8-K carries no event date", () => {
    const { events } = parseSubmissions("1", [
      { form: "8-K", filingDate: "2026-05-15", reportDate: "", accessionNumber: "a", items: "2.02" },
    ]);
    expect(events[0]!.eventDateIso).toBe("2026-05-15");
  });
});
