import { describe, expect, it } from "vitest";
import { lagWeeks, maxLagDays } from "../src/ingesters/shared";
import { numberCheck } from "../src/rag/validate";

describe("lagWeeks", () => {
  it("floors, because a partial week is not six weeks", () => {
    expect(lagWeeks(45)).toBe(6); // 6.43 -> 6
    expect(lagWeeks(41)).toBe(5); // 5.86 -> 5, NOT 6
    expect(lagWeeks(42)).toBe(6);
    expect(lagWeeks(6)).toBe(0);
    expect(lagWeeks(0)).toBe(0);
  });

  it("stays null on a lag we do not have", () => {
    // A filing whose transactions carry no usable date has lagDays null, and
    // the derived field must not invent a zero -- "disclosed 0 weeks later"
    // is a claim, and an untrue one.
    expect(lagWeeks(null)).toBeNull();
    expect(lagWeeks(-3)).toBeNull();
    expect(lagWeeks(Number.NaN)).toBeNull();
  });
});

describe("maxLagDays", () => {
  const FILED = "2026-07-18T00:00:00.000Z";

  it("takes the OLDEST trade, where lagDays takes the newest", () => {
    // The case the field exists for: one PDF clearing months of trading.
    const txns = [
      { transactionDate: "03/22/2026" }, // 118 days
      { transactionDate: "05/30/2026" }, // 49
      { transactionDate: "07/14/2026" }, // 4
    ];
    expect(maxLagDays(FILED, txns)).toBe(118);
  });

  it("equals lagDays on a single-transaction filing rather than going null", () => {
    expect(maxLagDays(FILED, [{ transactionDate: "06/03/2026" }])).toBe(45);
  });

  it("ignores undated and future-dated transactions instead of poisoning the max", () => {
    // lagDays returns null for a trade dated after its own filing, so a
    // typo'd 2027 date must not become the maximum lag.
    const txns = [
      { transactionDate: "06/03/2026" }, // 45
      { transactionDate: "" },
      { transactionDate: "09/01/2027" }, // future -> null
    ];
    expect(maxLagDays(FILED, txns)).toBe(45);
    expect(maxLagDays(FILED, [{ transactionDate: "" }])).toBeNull();
    expect(maxLagDays(FILED, [])).toBeNull();
  });
});

describe("the exemplars these fields exist for", () => {
  function housePayload(over: Record<string, unknown> = {}) {
    return {
      member: "Hon. Example Member",
      chamber: "house",
      who: "Hon. Example Member",
      filedDate: "09/17/2026",
      tradeDate: "08/03/2026",
      amountBand: "$1,000,001 - $5,000,000",
      singleTxn: true,
      lagDays: 45,
      lagWeeks: lagWeeks(45),
      maxLagDays: 45,
      transactions: [{ transactionDate: "08/03/2026", amount: "$1,000,001 - $5,000,000", type: "P" }],
      ...over,
    };
  }

  it('lets "six weeks stale" through on ANY trade month, which lagDays alone did not', () => {
    // THE BUG THIS CLOSES, and it is nastier than a plain rejection.
    //
    // payloadFacts harvests every numeric token in the payload JSON, and that
    // includes MONTH NUMBERS. A trade dated 06/03 puts a 6 in the licensed
    // set, so "six weeks stale" passed -- not because the payload said six
    // weeks, but because the trade happened in June.
    //
    // Same filing, same 45-day lag, same true sentence, trade in August: the
    // 6 disappears and the draft is refused. A validator whose verdict on an
    // identical claim depends on the month is worse than one that always
    // says no, because the failure looks intermittent.
    const E1 = "Legal, disclosed, and six weeks stale. Working as intended, apparently.";

    const withoutWeeks = housePayload();
    delete (withoutWeeks as Record<string, unknown>).lagWeeks;
    expect(numberCheck(E1, withoutWeeks as never).length).toBeGreaterThan(0);

    expect(numberCheck(E1, housePayload() as never)).toEqual([]);

    // And a June trade, the coincidence case, still passes with the field.
    const june = housePayload({
      tradeDate: "06/03/2026",
      filedDate: "07/18/2026",
      transactions: [{ transactionDate: "06/03/2026", amount: "$1,000,001 - $5,000,000", type: "P" }],
    });
    expect(numberCheck(E1, june as never)).toEqual([]);
  });

  it('lets "up to 118 days of lag" through, which no field previously stated', () => {
    const E4 = "Up to 118 days of lag, all cleared in one afternoon.";
    const many = housePayload({
      lagDays: 4,
      lagWeeks: 0,
      maxLagDays: 118,
      singleTxn: false,
      transactions: [
        { transactionDate: "03/22/2026", amount: "$15,001 - $50,000", type: "P" },
        { transactionDate: "07/14/2026", amount: "$15,001 - $50,000", type: "P" },
      ],
    });
    expect(numberCheck(E4, many as never)).toEqual([]);

    const without = { ...many };
    delete (without as Record<string, unknown>).maxLagDays;
    expect(numberCheck(E4, without as never).length).toBeGreaterThan(0);
  });

  it("does NOT license the deadline or the penalty, which are not ours to state", () => {
    // "Eighty-seven days late. Deadline is 45. Penalty is $200." fails on 45
    // and $200, not on the lag. Those are STOCK Act constants -- world
    // knowledge, not parsed fields -- and no enrichment should make them
    // pass. Pinned so a later widening has to argue with this test.
    const E5 = "Eighty-seven days late. Deadline is 45. Penalty is $200.";
    const p = housePayload({ lagDays: 87, lagWeeks: lagWeeks(87), maxLagDays: 87 });
    const issues = numberCheck(E5, p as never);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.detail).join(" ")).toMatch(/200/);
  });
});
