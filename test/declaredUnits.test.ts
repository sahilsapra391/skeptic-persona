import { describe, expect, it } from "vitest";
import { declaredScales, groundingFacts, mergeFacts, numberCheck, payloadFacts } from "../src/rag/validate";

/** The real body of queue #919 as stored in items.raw_text — an RBI swap
 *  facility release whose table declares "(USD million)" in a header line and
 *  carries the values in rows. */
const RBI_BODY = String.raw`RBI had announced a facility for offering concessional swaps for fresh FCNR(B) deposits, OFCB and ECB inflows, on June 05, 2026 and the same was operationalised on June 08, 2026, which is available upto September 30, 2026, for the FCNR(B) deposits and upto December 31, 2026, for the OFCBs and ECBs.
Based on the data received from Authorised Dealer Banks, the position of forex inflows mobilised till July 31, 2026, under the above facility is given below.
Type Amount
(USD million)
FCNR(B) Deposits 36,725
OFCBs 2,575
ECBs 1,516
Total 40,816
(Brij Raj)
Chief General Manager
Press Release: 2026-2027/796`;

const RBI_PAYLOAD = {
  authority: "Reserve Bank of India",
  title: "Reporting of FCNR(B) Deposits, External Commercial Borrowings (ECBs) and Overseas Foreign Currency Borrowings (OFCBs) mobilized under Reserve Bank's Swap Facility",
  categories: [], publishedIso: "2026-08-01T09:45:00.000Z",
  factLine: "Reserve Bank of India: swap facility inflows",
} as never;

const licensed = () => mergeFacts(payloadFacts(RBI_PAYLOAD), groundingFacts(RBI_BODY));

describe("a declared unit is licensed with its number (p4-28)", () => {
  it("THE PRODUCTION CASE: the correct draft was rejected and the misleading one passed", () => {
    // #919 attempt 1 wrote the figure WITH its unit and was rejected; attempt 2
    // dropped the unit and passed. 40,816 million is forty billion dollars;
    // "40,816" alone is a thousand times too small. The validator was
    // rewarding the misleading form.
    const correct = "Swap-facility inflows: USD 40,816 million through July 31, 2026, per RBI.";
    const misleading = "Forex inflows total 40,816 by July 31, 2026, per RBI.";

    expect(numberCheck(correct, RBI_PAYLOAD, licensed()), "the unit-bearing draft must now pass").toEqual([]);
    // The bare form still passes — it is a number the table literally prints.
    // The fix is that the honest draft is no longer punished, not that the
    // terse one is banned.
    expect(numberCheck(misleading, RBI_PAYLOAD, licensed())).toEqual([]);
  });

  it("reads the declaration out of the document, not out of prose", () => {
    expect(declaredScales(RBI_BODY)).toContain(1e6);
    // A sentence that merely uses the word declares nothing. The model can
    // write "million"; only the SOURCE can declare it.
    expect(declaredScales("The agency recovered several million dollars last year.")).toEqual([]);
    expect(declaredScales("Revenue rose. Millions were involved.")).toEqual([]);
  });

  it("licenses the scaled figure ONLY under a declaration", () => {
    // Same numbers, no declaration: the scale-up must not appear.
    const undeclared = "FCNR(B) Deposits 36,725\nOFCBs 2,575\nECBs 1,516\nTotal 40,816";
    const withDecl = "Amount\n(USD million)\n" + undeclared;
    expect(groundingFacts(undeclared).numbers.has("40816000000")).toBe(false);
    expect(groundingFacts(withDecl).numbers.has("40816000000")).toBe(true);
  });

  it("recognises the forms real sources use, and refuses bare mentions", () => {
    for (const decl of ["(USD million)", "(in millions)", "(Rs. crore)", "in USD millions", "  million  ", "(USD mn)"]) {
      expect(declaredScales(`Amount\n${decl}\nTotal 40,816`), decl).not.toEqual([]);
    }
    for (const notDecl of ["a million reasons", "worth millions", "the Millionaire Fund"]) {
      expect(declaredScales(notDecl), notDecl).toEqual([]);
    }
  });

  it("does not license a number the document never printed at all", () => {
    // The widening is about MAGNITUDE of a stated figure, never about
    // inventing one. 99,999 appears nowhere in the RBI body, declared or not.
    const invented = "Swap-facility inflows: USD 99,999 million, per RBI.";
    expect(numberCheck(invented, RBI_PAYLOAD, licensed()).length).toBeGreaterThan(0);
  });
});
