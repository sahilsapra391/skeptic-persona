import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BODY_TEXT_CAP, captureEdgarBodies, edgarDirOf, pickPrimaryDoc } from "../src/ingesters/edgarBody";
import { insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { newTickBudget } from "../src/lib/budget";
import SOURCETEXT_SRC from "../src/rag/sourceText.ts?raw";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

const DIR_BASE = "https://www.sec.gov";
let seq = 0;

/** Seed an 8-K item shaped exactly as the ingester leaves it. */
async function seedPendingEightK(accession: string): Promise<number> {
  seq += 1;
  const dir = `/Archives/edgar/data/999${seq}/00099${seq}`;
  const res = await insertItem(
    env.DB,
    {
      source: "edgar_8k",
      externalId: accession,
      category: "filing",
      eventAt: null,
      sourceUrl: `${DIR_BASE}${dir}/${accession}-index.htm`,
      payload: { company: "ACME CORP", cik: "9990001", formType: "8-K", itemCodes: ["4.02"] },
      score: SCORE_POSTABLE,
      status: "logged",
    },
    new Date(),
  );
  lastDir = dir;
  return res.id!;
}

let lastDir = "";

/** Serve a directory listing plus the primary document for the last seed. */
function serveFiling(body: string) {
  fetchMock
    .get(DIR_BASE)
    .intercept({ path: `${lastDir}/index.json` })
    .reply(200, JSON.stringify({ directory: { item: [{ name: "acme-8k.htm" }] } }));
  fetchMock.get(DIR_BASE).intercept({ path: `${lastDir}/acme-8k.htm` }).reply(200, body);
}

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
  it("caps the stored body and flags it, THROUGH the real capture path", async () => {
    // The first version of this test sliced a string itself and asserted the
    // result, which is asserting AROUND the fix: all three substantive
    // changes reverted with the suite green. This drives captureEdgarBodies
    // and reads what actually landed in the row.
    const long = `<html><body><p>${"word ".repeat(80_000)}</p></body></html>`;
    const id = await seedPendingEightK("0009999999-26-000001");
    serveFiling(long);

    await captureEdgarBodies(env as never, new Date(), newTickBudget(20));

    const row = await env.DB.prepare(`SELECT raw_text AS t, raw_meta AS m FROM items WHERE id = ?1`)
      .bind(id)
      .first<{ t: string | null; m: string | null }>();
    expect(row!.t!.length).toBe(BODY_TEXT_CAP);
    expect(JSON.parse(row!.m!).truncated).toBe(true);
    expect(JSON.parse(row!.m!).document).toBeTruthy();
  });

  it("re-captures a row the generation fallback poisoned", async () => {
    // No cleanup migration: a one-off UPDATE fixes the rows that exist when
    // it runs, this fixes them whenever they appear. raw_meta.document is
    // written ONLY by this job -- the fallback never opened the directory
    // listing, so it cannot know which file it fetched -- which makes its
    // absence a reliable marker of index chrome.
    const id = await seedPendingEightK("0009999999-26-000003");
    await env.DB.prepare(`UPDATE items SET raw_text = ?1, raw_meta = ?2 WHERE id = ?3`)
      .bind(
        "EDGAR Filing Documents for 0001777393-26-000057",
        JSON.stringify({ mode: "full", host: "www.sec.gov", bytes: 2077 }),
        id,
      )
      .run();
    serveFiling("<html><body><p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION FORM 8-K</p></body></html>");

    await captureEdgarBodies(env as never, new Date(), newTickBudget(20));

    const row = await env.DB.prepare(`SELECT raw_text AS t, raw_meta AS m FROM items WHERE id = ?1`)
      .bind(id)
      .first<{ t: string; m: string }>();
    expect(row.t).toContain("FORM 8-K");
    expect(row.t).not.toContain("EDGAR Filing Documents");
    expect(JSON.parse(row.m).document).toBeTruthy();
  });

  it("scrubs URLs out of the stored body, THROUGH the real capture path", async () => {
    // 8-K bodies carry URLs constantly. A scheme-less .gov echoed into a post
    // is linkified by X while our weighted-length counter scores it at 7
    // instead of 23.
    const withUrl = "<html><body><p>See www.sec.gov/x and https://ir.acme.com/q2 for detail.</p></body></html>";
    const id = await seedPendingEightK("0009999999-26-000002");
    serveFiling(withUrl);

    await captureEdgarBodies(env as never, new Date(), newTickBudget(20));

    const t = (await env.DB.prepare(`SELECT raw_text AS t FROM items WHERE id = ?1`).bind(id).first<{ t: string }>())!.t;
    expect(t).not.toContain("www.sec.gov");
    expect(t).not.toContain("ir.acme.com");
    expect(t).toContain("for detail");
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
    // Anchor on the guard INSIDE fetchSourceText, not the exported helper
    // near the top of the file -- the helper mentions the same constant and
    // would make this ordering check meaningless.
    const guardAt = SOURCETEXT_SRC.indexOf("DEDICATED_CAPTURE_SOURCES.includes(item.source)");
    const cachedAt = SOURCETEXT_SRC.indexOf("cached: true");
    expect(cachedAt).toBeGreaterThan(-1);
    expect(cachedAt).toBeLessThan(guardAt);
  });
});
