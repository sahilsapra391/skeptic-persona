import { env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { lakeContext } from "../src/rag/context";
import { fetchSourceText } from "../src/rag/sourceText";
import { htmlToText, scrubUrls } from "../src/lib/html";
import { groundingFacts, mergeFacts, payloadFacts, numberCheck, entityCheck } from "../src/rag/validate";
import { buildPrompt } from "../src/rag/generate";
import { parsePressFeed } from "../src/ingesters/regulatoryPress";

const NOW = new Date("2026-08-01T20:00:00.000Z");

async function seedPress(externalId: string, title: string, eventAt: string): Promise<number> {
  const res = await insertItem(
    env.DB,
    {
      source: "press_cftc_enforcement",
      externalId,
      category: "regulatory",
      eventAt,
      sourceUrl: `https://www.cftc.gov/PressRoom/PressReleases/${externalId}`,
      payload: { authority: "CFTC", title, factLine: `CFTC: ${title}` },
      score: SCORE_POSTABLE,
    },
    NOW,
  );
  return res.id ?? 0;
}

describe("lakeContext (p4-01)", () => {
  it("entity-level priors with counts, titles, dates; the current item excluded", async () => {
    await seedPress("9274-26", "CFTC Charges Alpha Trading LLC", "2026-07-29T15:00:00.000Z");
    await seedPress("9275-26", "CFTC Settles With Beta Fund", "2026-07-30T15:00:00.000Z");
    const current = await seedPress("9276-26", "CFTC Orders George Santos to Pay $35,000", "2026-07-31T19:26:52.000Z");

    const ctx = await lakeContext(
      env.DB,
      { id: current, source: "press_cftc_enforcement", archetype: "REGULATORY_NEWS" },
      { authority: "CFTC" },
    );
    expect(ctx.lines.length).toBeGreaterThan(0);
    expect(ctx.lines[0]).toContain("2 prior CFTC items");
    expect(ctx.lines[0]).toContain("since 2026-07-29");
    const joined = ctx.lines.join("\n");
    expect(joined).toContain("Beta Fund");
    expect(joined).toContain("(2026-07-30)");
    // Never itself.
    expect(joined).not.toContain("George Santos");
  });

  it("degrades to source-level when the entity key is missing, and to nothing on an empty lake", async () => {
    const a = await seedPress("9300-26", "CFTC Charges Gamma", "2026-07-28T12:00:00.000Z");
    const b = await seedPress("9301-26", "CFTC Charges Delta", "2026-07-29T12:00:00.000Z");
    // No authority in the payload -> source-level floor.
    const ctx = await lakeContext(env.DB, { id: b, source: "press_cftc_enforcement", archetype: "REGULATORY_NEWS" }, {});
    expect(ctx.lines[0]).toContain("1 prior press_cftc_enforcement item");
    expect(ctx.lines.join("\n")).toContain("Gamma");

    const empty = await lakeContext(env.DB, { id: a, source: "rate_boc", archetype: "RATE_DECISION" }, { country: "Canada" });
    expect(empty.lines).toEqual([]);
  });
});

describe("fetchSourceText (p4-01)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("fetches an official host in full, scrubs URLs, and caches write-once", async () => {
    const id = await seedPress("9400-26", "Cache test", "2026-07-31T00:00:00.000Z");
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/enf/x" })
      .reply(200, "<html><head><title>t</title></head><body><p>The Commission imposed a $2,300,000 penalty.</p><p>Details at https://www.sec.gov/detail</p><script>junk()</script></body></html>");

    const first = await fetchSourceText(
      env,
      { id, source_url: "https://www.sec.gov/enf/x", raw_text: null, raw_meta: null },
      NOW,
    );
    expect(first).not.toBeNull();
    expect(first!.mode).toBe("full");
    expect(first!.cached).toBe(false);
    expect(first!.text).toContain("$2,300,000 penalty");
    expect(first!.text).not.toContain("junk()");
    expect(first!.text).not.toMatch(/https?:\/\//);

    const row = await env.DB.prepare(`SELECT raw_text, raw_meta FROM items WHERE id = ?1`)
      .bind(id)
      .first<{ raw_text: string | null; raw_meta: string | null }>();
    expect(row?.raw_text).toContain("$2,300,000");
    const meta = JSON.parse(row!.raw_meta!) as Record<string, unknown>;
    expect(meta["mode"]).toBe("full");
    expect(meta["host"]).toBe("www.sec.gov");
    expect(typeof meta["sha256"]).toBe("string");

    // Cached round: no interceptor registered, so a real fetch would throw.
    const second = await fetchSourceText(
      env,
      { id, source_url: "https://www.sec.gov/enf/x", raw_text: row!.raw_text, raw_meta: row!.raw_meta },
      NOW,
    );
    expect(second?.cached).toBe(true);
    expect(second?.text).toBe(row!.raw_text);
  });

  it("refuses egress-blocked hosts without attempting a fetch", async () => {
    const id = await seedPress("9401-26", "Blocked host", "2026-07-31T00:00:00.000Z");
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const got = await fetchSourceText(
        env,
        { id, source_url: "https://www.cftc.gov/PressRoom/x", raw_text: null, raw_meta: null },
        NOW,
      );
      expect(got).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const row = await env.DB.prepare(`SELECT raw_text FROM items WHERE id = ?1`).bind(id).first<{ raw_text: string | null }>();
    expect(row?.raw_text).toBeNull();
  });

  it("non-official hosts get the conservative excerpt cap", async () => {
    const id = await seedPress("9402-26", "Excerpt", "2026-07-31T00:00:00.000Z");
    fetchMock
      .get("https://news.example.com")
      .intercept({ path: "/a" })
      .reply(200, `<p>${"word ".repeat(600)}</p>`);
    const got = await fetchSourceText(
      env,
      { id, source_url: "https://news.example.com/a", raw_text: null, raw_meta: null },
      NOW,
    );
    expect(got!.mode).toBe("excerpt");
    expect(got!.text.length).toBeLessThanOrEqual(1200);
  });

  it("a failed fetch degrades to null and caches nothing", async () => {
    const id = await seedPress("9403-26", "Fail soft", "2026-07-31T00:00:00.000Z");
    fetchMock.get("https://www.fda.gov").intercept({ path: "/x" }).reply(404, "not here");
    const got = await fetchSourceText(env, { id, source_url: "https://www.fda.gov/x", raw_text: null, raw_meta: null }, NOW);
    expect(got).toBeNull();
    const row = await env.DB.prepare(`SELECT raw_text FROM items WHERE id = ?1`).bind(id).first<{ raw_text: string | null }>();
    expect(row?.raw_text).toBeNull();
  });
});

describe("grounding widens the whitelist to exactly what the prompt showed", () => {
  const payload = { authority: "CFTC", title: "Order against a trader", amountUsd: 35000 };
  const source =
    "The Commission's order requires payment of a $2,300,000 civil monetary penalty. " +
    "Filed on July 31, 2026. Gregory Hext consented. The order cites a rate of 3.5% and three subpoenas. Case total 45,000 units.";
  const merged = mergeFacts(payloadFacts(payload), groundingFacts(source));

  it("source-stated numbers, dates, entities and percents pass; payload-only rejects them", () => {
    expect(numberCheck("Penalty set at $2,300,000, filed July 31.", payload, merged)).toEqual([]);
    expect(numberCheck("Penalty set at $2,300,000.", payload, payloadFacts(payload)).length).toBeGreaterThan(0);
    expect(numberCheck("A 3.5% rate rode the order.", payload, merged)).toEqual([]);
    expect(entityCheck("Gregory Hext consented to the order.", payload, merged)).toEqual([]);
    expect(entityCheck("Gregory Hext consented.", payload, payloadFacts(payload)).length).toBeGreaterThan(0);
    expect(numberCheck("Regulators sent three subpoenas.", payload, merged)).toEqual([]);
  });

  it("the closed bypasses stay closed under grounding", () => {
    // Scale-up: 45,000 in the source never licenses $45 billion.
    expect(numberCheck("$45 billion at stake.", payload, merged).length).toBeGreaterThan(0);
    // A plain source number never becomes a percent claim.
    expect(numberCheck("Penalty up 45,000%.", payload, merged).length).toBeGreaterThan(0);
    // A date the source never stated still dies.
    expect(numberCheck("Filed July 30.", payload, merged).length).toBeGreaterThan(0);
    // A number in neither universe still dies.
    expect(numberCheck("A $9,999,999 fine.", payload, merged).length).toBeGreaterThan(0);
  });
});

describe("prompt carries the grounding blocks (p4-01)", () => {
  const EX = { archetype: "REGULATORY_NEWS" as const, text: "CFTC filed a complaint, per CFTC.", register: "wire" as const };
  const P = { authority: "CFTC", title: "Order", factLine: "CFTC: Order" };

  it("shows SOURCE DOCUMENT and LAKE CONTEXT and widens the stated fact rule", () => {
    const p = buildPrompt("REGULATORY_NEWS", P, [EX], [], {
      source: { text: "The order requires a $35,000 payment.", mode: "full", host: "www.cftc.gov", fetchedAt: "2026-08-01T20:00:00.000Z", cached: false },
      contextLines: ["2 prior CFTC items via press_cftc_enforcement in our lake since 2026-07-28."],
    });
    expect(p.user).toContain("SOURCE DOCUMENT (www.cftc.gov");
    expect(p.user).toContain("$35,000 payment");
    expect(p.user).toContain("LAKE CONTEXT");
    expect(p.user).toContain("2 prior CFTC items");
    expect(p.user).toContain("the payload, the SOURCE DOCUMENT, or the LAKE CONTEXT below");
    expect(p.user).toContain("No claims about market reaction");
    expect(p.user).not.toMatch(/https?:\/\//);
  });
});

describe("press descriptions become ingest-time grounding", () => {
  const feed = (desc: string) =>
    `<rss><channel><item><title>CFTC Orders X to Pay</title><link>https://www.cftc.gov/x</link>` +
    `<pubDate>Mon, 27 Jul 2026 09:20:41 GMT</pubDate><description>${desc}</description></item></channel></rss>`;

  it("extracts, strips HTML, scrubs URLs", () => {
    const items = parsePressFeed(
      feed("<![CDATA[<p>The order finds manipulative trading and requires a $35,000 penalty. See https://www.cftc.gov/detail for the filing.</p>]]>"),
    );
    expect(items[0]?.description).toContain("$35,000 penalty");
    expect(items[0]?.description).not.toContain("<p>");
    expect(items[0]?.description).not.toMatch(/https?:\/\//);
  });

  it("boilerplate-short descriptions are dropped rather than stored", () => {
    expect(parsePressFeed(feed("Press release."))[0]?.description).toBeNull();
  });

  it("htmlToText and scrubUrls behave on the raw primitives", () => {
    expect(htmlToText("<div>a<br>b</div>")).toBe("a\nb");
    expect(scrubUrls("see https://x.test/y and www.z.test now")).not.toMatch(/x\.test|z\.test/);
  });
});
