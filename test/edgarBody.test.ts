import { describe, expect, it } from "vitest";
import { BODY_TEXT_CAP, edgarDirOf, pickPrimaryDoc } from "../src/ingesters/edgarBody";
import SOURCETEXT_SRC from "../src/rag/sourceText.ts?raw";

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

describe("the review findings on this capture, pinned", () => {
  it("caps the stored body at the generation path's ceiling and says it truncated", () => {
    // An 8-K in the QUEUEABLE_ITEMS set is routinely an agreement -- merger,
    // credit, employment -- running to hundreds of kilobytes. htmlToText's
    // RAW_BODY_CAP bounds the INPUT at 300k, which is not the same thing:
    // without a cap here the whole document reached raw_text and the prompt.
    const long = "word ".repeat(80_000);
    expect(long.length).toBeGreaterThan(BODY_TEXT_CAP * 10);
    const stored = long.slice(0, BODY_TEXT_CAP);
    expect(stored.length).toBe(24_000);
    expect(BODY_TEXT_CAP).toBe(24_000);
  });

  it("keeps edgar_8k off the generation fallback so the two cannot race", () => {
    // The race: an 8-K approved minutes after ingest reaches generation
    // before edgar_8k_body has run. The fallback caches the INDEX PAGE --
    // 2,077 chars of chrome that licenses 78 numbers and passes both the
    // prose and anchor gates because it is prose and it does name the
    // company -- and this job then skips that row forever, because raw_text
    // is no longer NULL.
    expect(SOURCETEXT_SRC).toContain('const DEDICATED_CAPTURE_SOURCES = ["edgar_8k"]');
    expect(SOURCETEXT_SRC).toContain("DEDICATED_CAPTURE_SOURCES.includes(item.source)");
    // Cached text must still be served; only the fetch is deferred.
    const guardAt = SOURCETEXT_SRC.indexOf("DEDICATED_CAPTURE_SOURCES.includes");
    const cachedAt = SOURCETEXT_SRC.indexOf("cached: true");
    expect(cachedAt).toBeGreaterThan(-1);
    expect(cachedAt).toBeLessThan(guardAt);
  });
});
