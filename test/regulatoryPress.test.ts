import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FCA from "./fixtures/fca-news.xml.fixture?raw";
import EU from "./fixtures/eu-presscorner.xml.fixture?raw";
import {
  draftPress,
  isNewsworthy,
  makePressHandler,
  parsePressFeed,
  PRESS_SOURCES,
} from "../src/ingesters/regulatoryPress";
import { newTickBudget } from "../src/lib/budget";
import { ARCHETYPES } from "../src/templates/archetypes";
import { renderPost } from "../src/templates/render";

// Live fixtures captured 2026-07-28T02:32Z. THESE are the parse contract.
const NOW = new Date("2026-07-28T03:00:00Z");
const byId = (id: string) => PRESS_SOURCES.find((s) => s.id === id)!;

describe("parsePressFeed (live fixtures)", () => {
  it("parses FCA's human date format and its category taxonomy", () => {
    const items = parsePressFeed(FCA);
    expect(items.length).toBe(20);
    const first = items[0]!;
    expect(first.title).toContain("FCA");
    // "Monday, July 27, 2026 - 15:30" is not RFC-822.
    expect(first.publishedIso).toMatch(/^2026-07-27T/);
    expect(first.categories).toContain("Press Releases");
  });

  it("parses the EU Commission's RFC-822 dates", () => {
    const items = parsePressFeed(EU);
    expect(items.length).toBe(20);
    expect(items[0]?.publishedIso).toMatch(/^2026-07-27T/);
    expect(items.some((i) => /Daily News/i.test(i.title))).toBe(true);
  });

  it("drops items missing a title, link or readable date rather than guessing", () => {
    expect(parsePressFeed("<rss><channel><item><title>x</title></item></channel></rss>")).toEqual([]);
    expect(
      parsePressFeed("<rss><channel><item><title>x</title><link>u</link><pubDate>garbage</pubDate></item></channel></rss>"),
    ).toEqual([]);
  });
});

describe("isNewsworthy — selection, never a claim", () => {
  it("FCA: enforcement in, blogs and speeches out", () => {
    const src = byId("press_fca");
    const items = parsePressFeed(FCA);
    const kept = items.filter((i) => isNewsworthy(src, i));
    const dropped = items.filter((i) => !isNewsworthy(src, i));

    expect(kept.every((i) => i.categories.some((c) => ["Press Releases", "Statements"].includes(c)))).toBe(true);
    // The live feed genuinely mixes in blogs; if it stops, this test tells us.
    expect(dropped.some((i) => i.categories.includes("Blogs"))).toBe(true);
  });

  it("EU Commission: the daily digest is not an event", () => {
    const src = byId("press_eu_commission");
    const items = parsePressFeed(EU);
    const daily = items.find((i) => /^Daily News/i.test(i.title))!;
    expect(daily).toBeTruthy();
    expect(isNewsworthy(src, daily)).toBe(false);
    // A real announcement still passes.
    const real = items.find((i) => !/^Daily News/i.test(i.title))!;
    expect(isNewsworthy(src, real)).toBe(true);
  });
});

describe("REGULATORY_NEWS is numberless by construction", () => {
  it("no beat has a slot a figure could occupy", () => {
    for (const beat of ARCHETYPES.REGULATORY_NEWS.beats) {
      const slots = beat.text.match(/\{([a-zA-Z0-9_.]+)\}/g) ?? [];
      // The only permitted slot is a date, which is parsed and non-numeric
      // in the sense that matters: it cannot become a fabricated quantity.
      for (const s of slots) expect(s).toBe("{publishedIso}");
    }
  });

  it("renders fact + attribution and survives the publish guard", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const item = parsePressFeed(FCA)[0]!;
    const src = byId("press_fca");
    const r = renderPost(
      ARCHETYPES.REGULATORY_NEWS,
      {
        factLine: draftPress(src, item),
        authority: src.authority,
        title: item.title,
        publishedIso: item.publishedIso,
      },
      { seed: "reg:1" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per the issuing authority");
    expect(r.text).not.toContain("—");
    expect(checkRegister(r.text, "REGULATORY_NEWS")).toEqual([]);
  });
});

describe("poll end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("FCA: newsworthy items queue, blogs land in the lake", async () => {
    const src = byId("press_fca");
    const u = new URL(src.url);
    fetchMock.get(u.origin).intercept({ path: u.pathname + u.search }).reply(200, FCA);

    await makePressHandler(src)(env, new Date("2026-07-27T18:00:00Z"), newTickBudget(30));

    const rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1").bind(src.id).all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(20);
    expect(rows.results.some((r) => r.score === 1)).toBe(true); // blogs
    expect(rows.results.some((r) => r.score >= 2)).toBe(true); // enforcement
  });

  it("a failing feed counts a failure and ingests nothing", async () => {
    const src = byId("press_eu_commission");
    const u = new URL(src.url);
    fetchMock.get(u.origin).intercept({ path: u.pathname + u.search }).reply(503, "down");
    await makePressHandler(src)(env, NOW, newTickBudget(30));

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(src.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
    const st = await env.DB.prepare("SELECT consecutive_failures AS f FROM source_state WHERE source = ?1").bind(src.id).first<{ f: number }>();
    expect(st?.f).toBe(1);
  });
});
