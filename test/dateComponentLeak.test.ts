import { describe, expect, it } from "vitest";
import { groundingFacts, numberCheck, payloadFacts } from "../src/rag/validate";

// BYPASS #4, THE OTHER HALF.
//
// Date components are consumed structurally so they never enter the licensed
// numeric set as free integers. That fix matched ISO only, on the assumption
// stated in CLAUDE.md that "all times stored as ISO-8601 UTC". Live house_ptr
// payloads do not — they carry the Clerk's slash dates verbatim — so on our
// highest-engagement source the guarantee was not holding.
//
// The payload below is copied from production (Morrison, MN03).
const REAL_HOUSE_PTR = {
  member: "Kelly Louise Morrison", stateDst: "MN03", filedDate: "7/30/2026",
  efiled: true, chamber: "house", who: "Kelly Louise Morrison",
  tradeDate: "06/29/2026", amountBand: "$15,001 - $50,000", singleTxn: true,
  lagDays: 31, bandSpanRatio: 3.3, bandWidthUsd: 34999,
  transactions: [{
    owner: "SP", assetName: "Honeywell Aerospace Inc. - Common Stock", ticker: "HONAV",
    assetType: "ST", type: "E", transactionDate: "06/29/2026",
    notificationDate: "07/06/2026", amount: "$15,001 - $50,000",
  }],
};

describe("date components never license a quantity", () => {
  it("HIGH: a real slash-date payload licensed fabricated counts", () => {
    // Before the fix the licensed small integers were 3, 6, 7, 29, 30, 31 —
    // and 6, 7, 29, 30 are nothing but month and day digits.
    for (const draft of [
      "Seven filings cleared today.",   // 7  = month of filedDate
      "30 transactions in one PDF.",    // 30 = day of filedDate
      "29 separate purchases.",         // 29 = day of tradeDate
    ]) {
      expect(numberCheck(draft, REAL_HOUSE_PTR).length, draft).toBeGreaterThan(0);
    }
    const small = [...payloadFacts(REAL_HOUSE_PTR).numbers]
      .map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 31).sort((a, b) => a - b);
    expect(small).toEqual([3, 31]); // bandSpanRatio's 3, and lagDays — no calendar
  });

  it("the real dates still validate structurally, and lagDays still rides", () => {
    for (const draft of ["trade date June 29", "filed July 30", "in 2026", "31 days"]) {
      expect(numberCheck(draft, REAL_HOUSE_PTR).map((i) => i.detail), draft).toEqual([]);
    }
  });

  it("GROUNDING side too — the p4-01 widening had the same leak", () => {
    const g = groundingFacts("The filing was submitted 7/30/2026 by the member.");
    const small = [...g.numbers].map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 31);
    expect(small).toEqual([]);
    expect(g.dates.has("2026-7-30")).toBe(true); // consumed AS a date, not dropped
  });

  it("and the documented fraction/docket concern does not reopen", () => {
    // The slash form was excluded from the grounding grammar because a loose
    // pattern "would mint dates from fractions and dockets". The strict form
    // requires a four-digit year, so it does not.
    const g = groundingFacts("About 1/2 of holders responded; see docket 3-12345 and case 9/11 filings.");
    expect([...g.dates]).toEqual([]);
  });
});
