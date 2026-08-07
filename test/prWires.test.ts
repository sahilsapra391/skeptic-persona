import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseWireFeed, pollPrWire, WIRE_SOURCES, MAX_WIRE_ITEMS_PER_RUN } from "../src/ingesters/prWires";
import { newTickBudget } from "../src/lib/budget";
import { getSourceState } from "../src/lib/db";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// p5-21. The whole lane is defined by a refusal: a vendor wire item is
// DISCOVERY and can never card. Non-negotiable #3 bans vendor-data
// republishing; the p4 mesh rules say news items are discovery, never
// citation. These tests pin that it is structural, not a habit.

const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title><item><title>Acme Corp Reports Second Quarter Results</title><link>https://www.globenewswire.com/news-release/1</link><guid isPermaLink="false">g-1</guid><pubDate>Wed, 06 Aug 2026 13:30:00 GMT</pubDate></item><item><title>Beta Inc Announces Leadership Change</title><link>https://www.globenewswire.com/news-release/2</link><guid isPermaLink="false">g-2</guid><pubDate>Wed, 06 Aug 2026 13:31:00 GMT</pubDate></item></channel></rss>`;

describe("parsing", () => {
  it("splits on <item> rather than counting, and reads every one", () => {
    // D-53: `grep -c "<item>"` counts LINES and both real feeds are a single
    // line, so a count could only ever be 1 or 0 and read like a finding
    // about the feed's shape. This fixture is single-line for that reason.
    const items = parseWireFeed(FEED);
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("Acme Corp Reports Second Quarter Results");
    expect(items[0]!.guid).toBe("g-1");
    expect(items[0]!.pubDateIso).toBe("2026-08-06T13:30:00.000Z");
  });

  it("skips items with no title or no link, and falls back to link for guid", () => {
    const partial = `<rss><channel><item><title>No link here</title></item><item><link>https://www.prnewswire.com/x</link><title>Has both</title></item></channel></rss>`;
    const items = parseWireFeed(partial);
    expect(items).toHaveLength(1);
    expect(items[0]!.guid).toBe("https://www.prnewswire.com/x");
    expect(items[0]!.pubDateIso).toBeNull();
  });

  it("an unparseable date is null, never a guess", () => {
    const bad = `<rss><channel><item><title>t</title><link>https://x/1</link><pubDate>not a date</pubDate></item></channel></rss>`;
    expect(parseWireFeed(bad)[0]!.pubDateIso).toBeNull();
  });
});

describe("wire items are DISCOVERY and can never card", () => {
  it("inserts at log-only score with status logged, and enqueues nothing", async () => {
    const src = WIRE_SOURCES[0]!;
    fetchMock.get("https://www.globenewswire.com").intercept({ path: (p) => p.startsWith("/RssFeed") }).reply(200, FEED);
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM queue`).first<{ n: number }>();
    const inserted = await pollPrWire(env as never, src, new Date("2026-08-06T14:00:00.000Z"), newTickBudget());
    expect(inserted).toBe(2);

    const rows = await env.DB.prepare(
      `SELECT score, status, category FROM items WHERE source = ?1`,
    ).bind(src.id).all<{ score: number; status: string; category: string }>();
    expect(rows.results).toHaveLength(2);
    for (const r of rows.results) {
      // SCORE_LOG_ONLY, always. No branch raises it — a vendor wire item is
      // discovery and the desk publishes the company's own filing instead.
      expect(r.score).toBe(1);
      expect(r.status).toBe("logged");
      expect(r.category).toBe("wire_discovery");
    }
    // Nothing reached the approval queue.
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM queue`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("a 200 with zero parseable items is a SHAPE CHANGE, not a quiet day", async () => {
    const src = WIRE_SOURCES[1]!;
    fetchMock.get("https://www.prnewswire.com").intercept({ path: (p) => p.startsWith("/rss") }).reply(200, "<html>nope</html>");
    await pollPrWire(env as never, src, new Date("2026-08-06T14:00:00.000Z"), newTickBudget());
    const state = await getSourceState(env.DB, src.id);
    // Recorded as a failure so the registry notices, rather than showing a
    // healthy source that has silently stopped producing.
    expect(state.consecutiveFailures).toBeGreaterThan(0);
    expect(state.lastError ?? "").toContain("zero parseable items");
  });

  it("a non-2xx records the status and inserts nothing", async () => {
    const src = WIRE_SOURCES[1]!;
    fetchMock.get("https://www.prnewswire.com").intercept({ path: (p) => p.startsWith("/rss") }).reply(503, "down");
    const n = await pollPrWire(env as never, src, new Date("2026-08-06T15:00:00.000Z"), newTickBudget());
    expect(n).toBe(0);
    const state = await getSourceState(env.DB, src.id);
    expect(state.lastError ?? "").toContain("503");
  });

  it("both wires are registered, and ACCESSWIRE is not", () => {
    expect(WIRE_SOURCES.map((w) => w.wire).sort()).toEqual(["GlobeNewswire", "PR Newswire"]);
    // Retired 2026-08-06 (D-54): two documented paths, 404 and 500, from both
    // egress points. A wire we cannot read is simply not a source.
    expect(WIRE_SOURCES.some((w) => /accesswire/i.test(w.url))).toBe(false);
    expect(MAX_WIRE_ITEMS_PER_RUN).toBe(20);
  });
});
