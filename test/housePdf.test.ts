import { describe, expect, it } from "vitest";
import SINGLE from "./fixtures/house-ptr-single.text.fixture?raw";
import MULTI from "./fixtures/house-ptr-multi.text.fixture?raw";
import PARTIAL from "./fixtures/house-ptr-partial-wrapped.text.fixture?raw";
import UNTRADED from "./fixtures/house-ptr-untraded.text.fixture?raw";
import SPACED from "./fixtures/house-ptr-spaced-amount.text.fixture?raw";
import GLUED from "./fixtures/house-ptr-glued-code.text.fixture?raw";
import PAGEBREAK from "./fixtures/house-ptr-page-break.text.fixture?raw";
import { countTxnMarkers, draftHousePtr, parseHousePtrText } from "../src/ingesters/housePtr";

// Text extracted from two LIVE House PTR PDFs on 2026-07-28. Both were
// RC4-encrypted with an empty owner password and carried a real text layer.
describe("parseHousePtrText", () => {
  it("parses a single-transaction filing with its owner code", () => {
    const txns = parseHousePtrText(SINGLE);
    expect(txns.length).toBe(1);
    expect(txns[0]).toMatchObject({
      owner: "SP", // spouse
      ticker: "ARCC",
      assetType: "ST",
      type: "S",
      transactionDate: "07/24/2026",
      notificationDate: "07/24/2026",
      amount: "$1,001 - $15,000",
    });
    expect(txns[0]!.assetName).toContain("Ares Capital");
  });

  it("parses every transaction in a 16-transaction, 3-page filing", () => {
    const txns = parseHousePtrText(MULTI);
    expect(txns.length).toBe(16);
    for (const t of txns) {
      expect(t.type).toMatch(/^[A-Z]$/);
      expect(t.transactionDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      expect(t.notificationDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      expect(t.amount).toMatch(/^\$[\d,]+ - \$[\d,]+$/);
      expect(t.assetName.length).toBeGreaterThan(0);
    }
  });

  it("catches a transaction that shares its line with the asset name", () => {
    // VERIFIED NECESSARY: when the name is short enough not to wrap, both sit
    // on one line — "Home Depot, Inc. (HD) [ST] P 06/17/2026...". A
    // start-anchored pattern dropped this entire trade, which is fabrication
    // by omission: the post looks complete and the trade is simply gone.
    const txns = parseHousePtrText(MULTI);
    const hd = txns.find((t) => t.ticker === "HD");
    expect(hd).toBeTruthy();
    expect(hd!.assetName).toContain("Home Depot");
    expect(hd!.amount).toBe("$1,001 - $15,000");
    expect(hd!.type).toBe("P");
  });

  it("does not bleed one asset name into the next transaction", () => {
    // The multi filing repeats AMAT three times in a row; if the backward
    // walk overran a block boundary the names would concatenate.
    const txns = parseHousePtrText(MULTI);
    const amat = txns.filter((t) => t.ticker === "AMAT");
    expect(amat.length).toBeGreaterThanOrEqual(3);
    for (const t of amat) {
      expect(t.assetName).toContain("Applied Materials");
      expect(t.assetName).not.toContain("HCA");
      expect(t.assetName.length).toBeLessThan(80);
    }
  });

  it("treats a missing owner prefix as the filer, not as part of the name", () => {
    const txns = parseHousePtrText(MULTI);
    // The live filing has both prefixed (DC) and unprefixed entries.
    expect(txns.some((t) => t.owner === "DC")).toBe(true);
    expect(txns.some((t) => t.owner === "")).toBe(true);
    for (const t of txns) {
      expect(t.assetName).not.toMatch(/^(SP|DC|JT)\s/);
    }
  });

  it("keeps the amount band VERBATIM and never derives a midpoint", () => {
    const txns = parseHousePtrText(MULTI);
    for (const t of txns) {
      expect(t.amount).toContain(" - ");
      expect(t.amount).toMatch(/^\$/);
    }
  });

  it("strips the NULL bytes the font encoding injects into headers", () => {
    // The PDF's header text arrives as "P\u0000\u0000\u0000 T\u0000..." —
    // "PERIODIC TRANSACTION REPORT" with characters lost to a font quirk.
    expect(SINGLE).toContain("\u0000");
    for (const t of parseHousePtrText(SINGLE)) {
      expect(t.assetName).not.toContain("\u0000");
      expect(t.amount).not.toContain("\u0000");
      expect(t.ticker ?? "").not.toContain("\u0000");
    }
  });

  it("returns nothing for text with no transaction table rather than guessing", () => {
    expect(parseHousePtrText("")).toEqual([]);
    expect(parseHousePtrText("Name: Hon. Someone\nStatus: Member")).toEqual([]);
    // A date-shaped line that is not a transaction row must not match.
    expect(parseHousePtrText("Digitally Signed: Hon. X , 07/24/2026")).toEqual([]);
  });
});

describe("countTxnMarkers — checking the parser against the document", () => {
  it("agrees with the strict parser on both live filings", () => {
    for (const [label, text] of [
      ["single", SINGLE],
      ["multi", MULTI],
    ] as const) {
      expect(countTxnMarkers(text), label).toBe(parseHousePtrText(text).length);
    }
  });

  it("would have caught the dropped Home Depot trade", () => {
    // The regression this exists for: the strict pattern read 15 of 16 and
    // nothing downstream could tell. A count the DOCUMENT emits is the only
    // independent signal available.
    expect(countTxnMarkers(MULTI)).toBe(16);
  });

  it("counts markers even where the strict pattern cannot anchor", () => {
    // Asset name and transaction sharing one line: loose sees it, and a
    // start-anchored strict pattern historically did not.
    const shared = "Home Depot, Inc. (HD) [ST] P 06/17/202606/30/2026$1,001 - $15,000";
    expect(countTxnMarkers(shared)).toBe(1);
  });

  it("is zero for text with no transactions", () => {
    expect(countTxnMarkers("Name: Hon. Someone")).toBe(0);
    expect(countTxnMarkers("")).toBe(0);
  });
});

describe("live shapes the two original fixtures did not contain", () => {
  // Both were found by countTxnMarkers disagreeing with the parser on real
  // filings, not by reading the PDFs and guessing. Captured 2026-07-28.
  it("reads a partial sale whose amount band wraps across two lines", () => {
    // Filing 20034736: "S (partial) 07/21/202607/22/2026$15,001 -" / "$50,000".
    // The bare-letter type and the complete-band requirement each dropped it.
    const txns = parseHousePtrText(PARTIAL);
    expect(countTxnMarkers(PARTIAL)).toBe(txns.length);
    expect(txns.length).toBe(1);
    expect(txns[0]).toMatchObject({
      type: "S (partial)",
      ticker: "NVDA",
      assetType: "ST",
      transactionDate: "07/21/2026",
      amount: "$15,001 - $50,000",
    });
    expect(txns[0]!.assetName).toContain("NVIDIA");
  });

  it("keeps a non-traded asset's name whole and claims no ticker", () => {
    // Filing 20035075: "Opportunity Fund II (GLAS Funds, LP) [HN]". The
    // parenthesis is part of the NAME; reading it as a ticker would invent one.
    const txns = parseHousePtrText(UNTRADED);
    expect(countTxnMarkers(UNTRADED)).toBe(txns.length);
    expect(txns.length).toBe(1);
    expect(txns[0]!.ticker).toBeNull();
    expect(txns[0]!.assetType).toBe("HN");
    // EXACT, not toContain. A toContain on the TAIL of a name cannot detect a
    // head truncation, and that is precisely what shipped: the two-line walk
    // dropped "Riverside Acceleration Capital" and this assertion passed.
    expect(txns[0]!.assetName).toBe("Riverside Acceleration Capital Opportunity Fund II (GLAS Funds, LP)");
    expect(txns[0]!.assetName).not.toContain("[");
  });

  it("labels a qualified transaction code without guessing at it", () => {
    expect(draftHousePtr("Member", parseHousePtrText(PARTIAL), "2026-07-27T00:00:00.000Z", "07/27/2026")).toContain(
      "Sale (partial)",
    );
  });
});

describe("the courier's wire format", () => {
  it("carries NUL bytes intact through the double-encoded body", () => {
    // The courier does `jq -Rs '{source, fetchedAt, body: .}'`, so the bundle
    // arrives as a JSON STRING inside a JSON object. House PDFs are full of
    // NUL bytes from a font-encoding quirk (875 of them across the four live
    // filings this branch verified), and the parser strips them on the way
    // in. Confirmed against real jq output that they survive the round trip.
    // If an encoding step ever ate them, asset names would silently gain
    // spaces instead of losing junk, so this is pinned.
    const withNuls =
      "Ares Capital\u0000\u0000 Corporation\u0000 (ARCC) [ST]\nS 07/24/202607/24/2026$1,001 - $15,000";

    // Survives JSON.stringify -> JSON.parse exactly as the relay body does.
    const overTheWire = JSON.parse(JSON.stringify({ docs: [{ docId: "d", text: withNuls }] })) as {
      docs: { text: string }[];
    };
    expect(overTheWire.docs[0]!.text).toBe(withNuls);
    expect(overTheWire.docs[0]!.text.split("\u0000").length - 1).toBe(3);

    const txns = parseHousePtrText(overTheWire.docs[0]!.text);
    expect(txns.length).toBe(1);
    expect(txns[0]!.ticker).toBe("ARCC");
    expect(txns[0]!.assetName).toBe("Ares Capital Corporation");
    expect(txns[0]!.assetName).not.toContain("\u0000");
  });
});

describe("shapes the completeness gate caught in PRODUCTION, 2026-08-01", () => {
  // Six live filings were refused rather than posted with trades missing.
  // These are three of them. The gate did not just prevent bad posts; it
  // located every remaining blind spot in the parser.

  it("reads a transaction whose amount is separated from the dates by a space", () => {
    // Filing 20033718: "P 12/18/202512/19/2025 $100,001 - $250,000".
    // The pattern required the amount glued to the second date.
    expect(SPACED).toContain("12/19/2025 $100,001");
    const txns = parseHousePtrText(SPACED);
    expect(countTxnMarkers(SPACED)).toBe(txns.length);
    expect(txns.length).toBe(4);
    expect(txns.some((t) => t.amount === "$100,001 - $250,000")).toBe(true);
  });

  it("reads a transaction code glued to the end of the asset cell", () => {
    // Filing 20034036: "Procter & Gamble Company (PG) [ST]P 02/09/2026...".
    // The code needed whitespace before it, so this trade vanished. A bracket
    // or a lowercase letter is a boundary too, but an UPPERCASE one is not:
    // "(XOM)P" must never be read as ticker XOM plus code P.
    expect(GLUED).toMatch(/\[ST\]P \d{2}\/\d{2}\/\d{4}/);
    const txns = parseHousePtrText(GLUED);
    expect(countTxnMarkers(GLUED)).toBe(txns.length);
    expect(txns.length).toBe(8);
    const pg = txns.find((t) => t.ticker === "PG");
    expect(pg).toBeTruthy();
    // The bracket is a LOOKBEHIND, not consumed: eating it would strip the
    // [ST] the tail parser needs to read the asset type.
    expect(pg!.assetType).toBe("ST");
    expect(pg!.assetName).toContain("Procter");
  });

  it("still REFUSES the filing whose row is split across a page break", () => {
    // Filing 20034660. The band opens "$15,001 -" on one page and closes on
    // the next, after the footer and a repeated table header -- and that
    // header contains the literal "$200?". Any rule that reached forward for
    // the next line starting with "$" would splice "$15,001 - $200" into a
    // member of Congress's trade record.
    //
    // Deliberately unparsed. The gate holds it, which is the correct outcome
    // and strictly better than a plausible wrong number.
    expect(PAGEBREAK).toContain("$15,001 -");
    expect(PAGEBREAK).toContain("$200?");
    const txns = parseHousePtrText(PAGEBREAK);
    expect(countTxnMarkers(PAGEBREAK)).toBe(16);
    expect(txns.length).toBe(15);
    for (const t of txns) {
      expect(t.amount).not.toContain("$200");
      expect(t.amount).toMatch(/^\$[\d,]+ - \$[\d,]+$/);
    }
  });
});

// The page-break fixture keeps the XOM band WRAPPED, so no committed fixture
// contains a bare `CommonP`-style truncation. Building it here once means the
// sweep below actually exercises the shape rather than iterating six inputs
// that cannot trip the guard -- the first version of that assertion passed
// with the guard deleted, which made it decorative.
const UNWRAPPED_PAGEBREAK = PAGEBREAK.replace(
  "JT Exxon Mobil Corporation CommonP 02/07/202505/29/2026$15,001 -",
  "JT Exxon Mobil Corporation CommonP 02/07/202505/29/2026$15,001 - $50,000",
);

describe("a lowercase boundary means TRUNCATED, not glued", () => {
  // Review finding from the p4 session, reproduced. Widening the boundary to
  // accept a lowercase letter looked like it rescued a glued cell. It does
  // not: every intact House asset cell ends in "[TYPE]" or ")", so a code
  // sitting straight after a lowercase letter can only occur when the rest of
  // the cell is on the next page.

  it("refuses the un-wrapped page-break shape instead of parsing a fragment", () => {
    // The p4 session's exact reproduction: take the page-break fixture and
    // un-wrap the XOM amount band, which turns it into the 20033916 shape.
    // Before this guard the parser read 16 of 16 and the gate PASSED, storing
    // assetName "Exxon Mobil Corporation Common" with a null ticker.
    const unwrapped = UNWRAPPED_PAGEBREAK;
    expect(unwrapped).not.toBe(PAGEBREAK);

    const txns = parseHousePtrText(unwrapped);
    // The count still says 16; the parser must NOT agree, or the gate is blind.
    expect(countTxnMarkers(unwrapped)).toBe(16);
    expect(txns.length).toBe(15);
    // No row may carry the truncated cell.
    expect(txns.some((t) => t.assetName.endsWith("Common"))).toBe(false);
  });

  it("still accepts a bracket boundary, which is a real glued cell", () => {
    // "[ST]S" is the genuine glue case and must keep working -- it is five of
    // the six production recoveries.
    const txns = parseHousePtrText(GLUED);
    expect(countTxnMarkers(GLUED)).toBe(txns.length);
    expect(txns.find((t) => t.ticker === "PG")).toBeTruthy();
  });

  it("never emits an asset whose name ends mid-cell", () => {
    // Across every fixture: a parsed row always carries either a ticker or a
    // name that terminated properly. A name ending in a lowercase word is the
    // signature of the truncation this guard exists to catch.
    for (const [label, text] of [
      ["multi", MULTI],
      ["single", SINGLE],
      ["glued", GLUED],
      ["spaced", SPACED],
      ["untraded", UNTRADED],
      ["pagebreak", PAGEBREAK],
      // The one input that can actually trip the guard. Without it this
      // sweep passes with the guard deleted.
      ["pagebreak-unwrapped", UNWRAPPED_PAGEBREAK],
    ] as const) {
      for (const t of parseHousePtrText(text)) {
        expect(t.ticker !== null || !/[a-z]$/.test(t.assetName), `${label}: ${t.assetName}`).toBe(true);
      }
    }
  });
});
