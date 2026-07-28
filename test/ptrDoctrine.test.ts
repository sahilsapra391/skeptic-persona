import { describe, expect, it } from "vitest";
import MULTI from "./fixtures/house-ptr-multi.text.fixture?raw";
import UNTRADED from "./fixtures/house-ptr-untraded.text.fixture?raw";
import { countTxnMarkers, houseDateToIso, houseTradeLine, draftHousePtr, parseHousePtrText } from "../src/ingesters/housePtr";
import { draftSenatePtr, tradeLineOf, efdDateToIso, type EfdRow, type EfdTxn } from "../src/ingesters/senatePtr";
import { lagDays, mdyToIso } from "../src/ingesters/shared";
import { ARCHETYPES } from "../src/templates/archetypes";
import { renderPost } from "../src/templates/render";
import { checkRegister } from "../src/templates/validate";

// Every case here is a confirmed defect from the adversarial review of the
// House PTR loop. They are doctrine failures, not style: each one produced a
// post that stated something the filing does not say.

describe("a truncated trade list always says it is truncated", () => {
  // THE BUG: tradeLine carried the first 3 trades with no marker. The honest
  // factLine (which does carry "+13 more") is over budget on a 16-trade
  // filing, so renderPost fell through to the ptr.whoWhen skeleton, meaning
  // the filings with the MOST omitted trades were exactly the ones that
  // would publish as if complete. senatePtr carried the same shape; it never
  // reached a post only because Senate eFD is blocked from Worker egress, so
  // zero CONGRESS_PTR rows have ever been queued. Latent, not shipped.
  const txns = parseHousePtrText(MULTI);

  it("marks the elision in the payload slot, not only in the fact line", () => {
    expect(txns.length).toBe(16);
    expect(houseTradeLine(txns)).toContain("+13 more");
    expect(draftHousePtr("Member", txns, "2026-07-27T00:00:00.000Z", "07/27/2026")).toContain("+13 more");
  });

  it("no CONGRESS_PTR skeleton can render a multi-trade filing as a complete list", () => {
    const payload = {
      chamber: "house",
      who: "Member",
      factLine: draftHousePtr("Member", txns, "2026-07-27T00:00:00.000Z", "07/27/2026"),
      tradeLine: houseTradeLine(txns),
      filedDate: "07/27/2026",
      tradeDate: txns[0]!.transactionDate,
      amountBand: txns[0]!.amount,
      lagDays: 39,
    };
    // Across seeds so BOTH skeletons and the over-budget fallback are hit.
    for (let i = 0; i < 24; i++) {
      const r = renderPost(ARCHETYPES.CONGRESS_PTR, payload, { seed: `seed-${i}` });
      expect(r.ok, `seed-${i}`).toBe(true);
      if (!r.ok) continue;
      expect(r.text, `seed-${i} must mark the 13 omitted trades`).toMatch(/\+13 more/);
    }
  });

  it("both chambers build the slot the same way", () => {
    const efd: EfdTxn[] = Array.from({ length: 5 }, (_, i) => ({
      type: "Purchase",
      amount: "$1,001 - $15,000",
      ticker: `AA${i}`,
      assetName: `Asset ${i}`,
      transactionDate: "06/24/2026",
    })) as EfdTxn[];
    expect(tradeLineOf(efd)).toContain("+2 more");
    expect(tradeLineOf(efd.slice(0, 3))).not.toContain("more");
  });
});

describe("a disclosure cannot precede its own trade", () => {
  // THE BUG: moving lagDays to shared.ts dropped `days >= 0 ? days : null`.
  // A future-dated transaction printed "disclosed -4 days after the latest
  // trade" and also won the "newest" slot driving tradeDate and amountBand.
  const filed = efdDateToIso("07/24/2026");

  it("returns null for a transaction dated after the filing", () => {
    expect(lagDays(filed, "07/28/2026")).toBeNull();
    expect(lagDays(filed, "07/24/2026")).toBe(0);
    expect(lagDays(filed, "06/17/2026")).toBe(37);
  });

  it("never emits a negative lag in either chamber's draft", () => {
    const mixed: EfdTxn[] = [
      { type: "Purchase", amount: "$1,001 - $15,000", ticker: "AAA", assetName: "A", transactionDate: "06/17/2026" },
      { type: "Sale", amount: "$1,001 - $15,000", ticker: "BBB", assetName: "B", transactionDate: "07/28/2026" },
    ] as EfdTxn[];
    const row = { display: "Doe, Jane (Senator)", filedDate: "07/24/2026" } as EfdRow;
    expect(draftSenatePtr(row, mixed, filed)).not.toContain("disclosed -");

    const house = parseHousePtrText(MULTI);
    expect(draftHousePtr("Member", house, "2026-01-01T00:00:00.000Z", "01/01/2026")).not.toContain("disclosed -");
  });
});

describe("an asset is named exactly as the filing names it", () => {
  // THE BUG: the backward name walk capped at 2 lines, but the House asset
  // column wraps to three on live filing 20035075, silently dropping the
  // sponsor. The original test used toContain on the TAIL of the name, which
  // cannot detect a head truncation — that is what let it ship.
  it("keeps every line of a three-line asset name", () => {
    const t = parseHousePtrText(UNTRADED)[0]!;
    expect(t.assetName).toBe("Riverside Acceleration Capital Opportunity Fund II (GLAS Funds, LP)");
    expect(t.ticker).toBeNull();
    expect(t.assetType).toBe("HN");
  });

  it("does not absorb an entry footer into the next asset name", () => {
    // "D:" (description) rows carry their own dollar figures. Widening the
    // walk without stopping at them would inject a number from a different
    // field entirely into an asset name.
    for (const t of parseHousePtrText(UNTRADED)) {
      expect(t.assetName).not.toContain("Capital call");
      expect(t.assetName).not.toMatch(/^\s*[DL]\s*:/);
    }
    expect(parseHousePtrText(MULTI).length).toBe(16);
  });
});

describe("the completeness gate does not share the parser's blind spot", () => {
  // THE BUG: both the marker count and the transaction pattern required the
  // dates and amount to be GLUED together. An extraction that separated them
  // was invisible to both, so the equality check passed on a short read.
  it("counts a transaction whose date pair and amount are separated", () => {
    const separated = "Acme Corp (ACME) [ST]\nP 06/17/2026 06/30/2026 $1,001 - $15,000";
    expect(countTxnMarkers(separated)).toBe(1);
  });

  it("still agrees with the parser on every live fixture", () => {
    for (const [label, text] of [
      ["multi", MULTI],
      ["untraded", UNTRADED],
    ] as const) {
      expect(countTxnMarkers(text), label).toBe(parseHousePtrText(text).length);
    }
  });
});

describe("the register check knows which chamber the item is", () => {
  // THE BUG: accepting any citation from the archetype's map meant a
  // hand-edited House draft ending "per Senate eFD" passed. Edited text is
  // the ONLY path that bypasses the renderer, so this is its only guard.
  const houseText = "House PTR: Member. Sale $1,001 - $15,000, NVDA (07/21/2026), per House Clerk";
  const wrongText = "House PTR: Member. Sale $1,001 - $15,000, NVDA (07/21/2026), per Senate eFD";

  it("accepts the citation correct for this item", () => {
    expect(checkRegister(houseText, "CONGRESS_PTR", { chamber: "house" }).map((i) => i.rule)).not.toContain(
      "attribution",
    );
  });

  it("rejects the other chamber's citation when it knows the item", () => {
    expect(checkRegister(wrongText, "CONGRESS_PTR", { chamber: "house" }).map((i) => i.rule)).toContain("attribution");
  });

  it("falls back to the closed set when the payload is unavailable", () => {
    // Degraded, but never permissive beyond our own declared sources.
    expect(checkRegister(wrongText, "CONGRESS_PTR").map((i) => i.rule)).not.toContain("attribution");
    expect(checkRegister("no citation at all", "CONGRESS_PTR").map((i) => i.rule)).toContain("attribution");
  });
});

describe("one date parser for congressional filings", () => {
  // THE BUG: moving lagDays out of senatePtr replaced its delegation to
  // efdDateToIso with an inlined /^(\d{2})\/(\d{2})\/(\d{4})$/. Neither
  // source zero-pads: the live House bulk index serves "2/11/2026" and
  // "7/8/2026" today. An unpadded date returned null and the entire
  // disclosure-lag clause silently vanished from the post.
  it("accepts unpadded dates, which both sources actually serve", () => {
    expect(mdyToIso("2/11/2026")).toBe("2026-02-11T00:00:00.000Z");
    expect(mdyToIso("7/8/2026")).toBe("2026-07-08T00:00:00.000Z");
    expect(mdyToIso("07/08/2026")).toBe("2026-07-08T00:00:00.000Z");
    expect(mdyToIso("not a date")).toBe("");
  });

  it("computes a lag from an unpadded transaction date", () => {
    expect(lagDays(mdyToIso("7/24/2026"), "6/17/2026")).toBe(37);
    expect(lagDays(mdyToIso("07/24/2026"), "06/17/2026")).toBe(37);
  });

  it("both chambers' date helpers are the same parser", () => {
    for (const d of ["1/1/2026", "12/31/2026", "07/08/2026"]) {
      expect(efdDateToIso(d)).toBe(mdyToIso(d));
      expect(houseDateToIso(d)).toBe(mdyToIso(d));
    }
  });
});
