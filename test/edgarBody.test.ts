import { describe, expect, it } from "vitest";
import { edgarDirOf, pickPrimaryDoc } from "../src/ingesters/edgarBody";

// Real EDGAR directory listing, accession 0001777393-26-000057, fetched
// 2026-08-01. Every name below is verbatim from index.json.
const REAL_LISTING = [
  { name: "0001777393-26-000057-index-headers.html" },
  { name: "0001777393-26-000057-index.html" },
  { name: "0001777393-26-000057.txt" },
  { name: "0001777393-26-000057-xbrl.zip" },
  { name: "chpt-20260728.htm" },
  { name: "chpt-20260728.xsd" },
  { name: "chpt-20260728_htm.xml" },
  { name: "chpt-20260728_lab.xml" },
];

describe("pickPrimaryDoc", () => {
  it("picks the filing, not the index page beside it", () => {
    // The index page is what source_url points at, and fetching it returns
    // navigation chrome plus a Google Tag Manager snippet. That is the bug
    // this whole job exists for.
    expect(pickPrimaryDoc(REAL_LISTING)).toBe("chpt-20260728.htm");
  });

  it("cannot be fooled by the listing's own type field", () => {
    // EDGAR's index.json reports type as an ICON FILENAME ("text.gif") for
    // every entry, so document type is not available and the name is the
    // only signal. Asserted so nobody later "improves" this by reading type.
    const typed = REAL_LISTING.map((f) => ({ ...f, type: "text.gif" }));
    expect(pickPrimaryDoc(typed)).toBe("chpt-20260728.htm");
  });

  it("skips XBRL siblings that share the stem", () => {
    for (const name of ["chpt-20260728_htm.xml", "chpt-20260728_lab.xml", "chpt-20260728.xsd"]) {
      expect(pickPrimaryDoc([{ name }]), name).toBeNull();
    }
  });

  it("returns null rather than guessing when there is no content document", () => {
    expect(pickPrimaryDoc([])).toBeNull();
    expect(pickPrimaryDoc([{ name: "0001-index.html" }, { name: "0001.txt" }])).toBeNull();
  });
});

describe("edgarDirOf", () => {
  it("derives the filing directory from the stored index url", () => {
    expect(edgarDirOf("https://www.sec.gov/Archives/edgar/data/1777393/000177739326000057/0001777393-26-000057-index.htm")).toBe(
      "https://www.sec.gov/Archives/edgar/data/1777393/000177739326000057",
    );
  });

  it("refuses anything that is not an EDGAR archive path", () => {
    // A wrong directory would send an authenticated-looking SEC fetch at a
    // host we never verified, so this fails closed rather than guessing.
    expect(edgarDirOf("https://example.test/whatever")).toBeNull();
    expect(edgarDirOf("http://www.sec.gov/Archives/edgar/data/1/2/x-index.htm")).toBeNull();
    expect(edgarDirOf("")).toBeNull();
  });
});
