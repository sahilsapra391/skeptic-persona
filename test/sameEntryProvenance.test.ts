import { describe, expect, it } from "vitest";
import { checkGroundingProvenance, numberCheck, payloadFacts, groundingFacts, mergeFacts } from "../src/rag/validate";
import { licensedGrounding } from "../src/rag/generate";

/** The real body of queue #919, an RBI swap-facility release, as stored in
 *  items.raw_text by the press ingester (mode "ingest_rss"). */
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
  categories: [],
  publishedIso: "2026-08-01T09:45:00.000Z",
  factLine: "Reserve Bank of India: Reporting of FCNR(B) Deposits, External Commercial Borrowings (ECBs) and Overseas Foreign Currency Borrowings (OFCBs) mobilized under Reserve Bank's Swap Facility",
} as never;

describe("same-entry capture licenses its own figures (p4-26)", () => {
  it("THE PRODUCTION CASE: #919's numbers were refused because the body says RBI and the payload says Reserve Bank of India", () => {
    // Without the mode, the anchor proxy fails: one anchor tried, no match.
    const blind = checkGroundingProvenance(RBI_BODY, RBI_PAYLOAD);
    expect(blind.ok).toBe(false);
    expect(blind.reason).toBe("no_anchor");
    expect(blind.anchorsTried).toBe(1);

    // With it, the text is licensed on the guarantee the ingester already gives.
    const known = checkGroundingProvenance(RBI_BODY, RBI_PAYLOAD, "ingest_rss");
    expect(known.ok).toBe(true);
    expect(known.reason).toBe("same_entry_capture");
  });

  it("and the draft the model actually wrote now passes numberCheck", () => {
    // Verbatim from generations id=48, rejected:number in production.
    const draft = "RBI reported FCNR(B) deposits 36,725, OFCBs 2,575, ECBs 1,516, per RBI.";
    const payloadOnly = payloadFacts(RBI_PAYLOAD);
    expect(numberCheck(draft, RBI_PAYLOAD, payloadOnly).length).toBeGreaterThan(0);
    const licensed = mergeFacts(payloadOnly, groundingFacts(RBI_BODY));
    expect(numberCheck(draft, RBI_PAYLOAD, licensed)).toEqual([]);
  });

  it("A FETCHED document still has to prove it belongs — this is not a relaxation", () => {
    // The class the gate was written for: a mis-fetched page whose numbers
    // would otherwise be licensed into our posts. Every fetch mode still fails.
    const wrongDoc = "EDGAR full-text search. 8,043 results. Browse the daily index for 2026-08-01.";
    for (const mode of ["full", "excerpt", undefined, "ingest_pdf", "anything_else"]) {
      const p = checkGroundingProvenance(wrongDoc, RBI_PAYLOAD, mode);
      expect(p.ok, `mode=${String(mode)} must not license a fetched document`).toBe(false);
    }
  });

  it("same-entry does NOT bypass the prose gate", () => {
    // Ordering matters and I got it wrong first: the short-circuit was above
    // looksLikeProse, so a PDF's internals captured via ingest_rss would have
    // been licensed — reopening the class where `/Prev 223302` entered the
    // fact whitelist. This asserts the order, not the wording.
    const binary = ("%PDF-1.4 /Prev 223302 /Type /Catalog /Pages 3 0 R endobj xref ").repeat(4);
    for (const mode of ["ingest_rss", "full", undefined]) {
      const p = checkGroundingProvenance(binary, RBI_PAYLOAD, mode);
      expect(p.ok, `mode=${String(mode)}`).toBe(false);
      expect(p.reason).toBe("not_prose");
    }
  });

  it("states the widening honestly: short same-entry bodies the anchor test refused are now licensed", () => {
    // The real bound, and it is a widening rather than a no-op. A body short
    // enough to clear looksLikeProse's 20-token exemption, from a payload that
    // DOES carry anchors, used to fail `no_anchor` and now passes on
    // same-entry. Pinned rather than glossed, because the honest claim is
    // "narrowed to the case it was written for", not "changed nothing".
    //
    // The residual risk is bounded by what ingest_rss can contain: a feed's
    // own <description>, which is the publisher's text, not a fetched
    // document. It cannot be a mis-fetched EDGAR page, which is the class the
    // anchor test exists for.
    const terse = "%PDF-1.4 /Prev 223302 /Type /Catalog /Pages 3 0 R endobj xref";
    expect(checkGroundingProvenance(terse, RBI_PAYLOAD).ok).toBe(false);
    expect(checkGroundingProvenance(terse, RBI_PAYLOAD).reason).toBe("no_anchor");
    expect(checkGroundingProvenance(terse, RBI_PAYLOAD, "ingest_rss").ok).toBe(true);
  });


  it("WIRING: one function decides, so the mode cannot be dropped at a call site", () => {
    // The hole this closes, and it took two attempts. Passing source.mode
    // explicitly from generate.ts left the wiring untested: deleting the
    // argument kept all 946 green, because a test can assert two functions
    // agree without asserting the caller connects them. licensedGrounding
    // reads the mode itself, so there is no argument left to drop.
    const source = { text: RBI_BODY, mode: "ingest_rss" };
    const same = licensedGrounding(source, RBI_PAYLOAD);
    expect(same.provenance.ok).toBe(true);
    expect(same.provenance.reason).toBe("same_entry_capture");
    expect(same.licensed).toBe(RBI_BODY);

    // A fetched document with the same body is still refused, and licenses "".
    const fetched = licensedGrounding({ text: RBI_BODY, mode: "full" }, RBI_PAYLOAD);
    expect(fetched.provenance.ok).toBe(false);
    expect(fetched.licensed).toBe("");
  });

});
