import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FED_FIXTURE from "./fixtures/fed-press-all.fixture?raw";
import NASDAQ_FIXTURE from "./fixtures/nasdaq-halts.fixture?raw";
import NYSE_FIXTURE from "./fixtures/nyse-halts.csv.fixture?raw";
import ICS_FIXTURE from "./fixtures/bls.ics.fixture?raw";
import CPI_FIXTURE from "./fixtures/cpi-nr0.fixture?raw";
import { draftFed, FED_FEED, parseFedFeed, pollFedPress, scoreFedItem } from "../src/ingesters/fedPress";
import {
  draftHalt,
  NASDAQ_HALTS_FEED,
  NYSE_HALTS_CSV,
  parseNasdaqHalts,
  parseNyseHalts,
  pollNasdaqHalts,
  pollNyseHalts,
} from "../src/ingesters/halts";
import { draftCpi, parseBlsIcs, parseCpiRelease, RELEASES, releaseUrl, syncBlsCalendar, watchBls } from "../src/ingesters/bls";
import { getSourceState } from "../src/lib/db";
import { zonedTimeToUtc, ET } from "../src/lib/time";

describe("fed press (live fixture)", () => {
  const items = parseFedFeed(FED_FIXTURE);

  it("parses all items with guid==link dedupe keys and UTC timestamps", () => {
    expect(items.length).toBe(20);
    const first = items[0]!;
    expect(first.title).toBe("Agencies issue joint statement on handling of highly sensitive information during bank examinations");
    expect(first.link).toBe("https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260716a.htm");
    expect(first.guid).toBe(first.link);
    expect(first.category).toBe("Banking and Consumer Regulatory Policy");
    expect(first.pubIso).toBe("2026-07-16T18:00:00.000Z");
  });

  it("pins the grade of EVERY category present in the live fixture", () => {
    const observed = new Map<string, number>();
    for (const i of items) observed.set(i.category, scoreFedItem(i));
    expect(Object.fromEntries(observed)).toEqual({
      "Monetary Policy": 3,
      "Enforcement Actions": 2,
      "Banking and Consumer Regulatory Policy": 2,
      "Other Announcements": 1,
    });
    expect(scoreFedItem({ ...items[0]!, category: "Brand New Category" })).toBe(1);
  });

  it("draft is the Fed's own headline, category-tagged", () => {
    expect(draftFed(items[0]!)).toBe(
      "Fed, Banking and Consumer Regulatory Policy: Agencies issue joint statement on handling of highly sensitive information during bank examinations",
    );
  });
});

describe("halts (live fixtures)", () => {
  it("nasdaq: real timestamp from HaltDate+HaltTime (ET->UTC), not the date-only pubDate", () => {
    const events = parseNasdaqHalts(NASDAQ_FIXTURE);
    expect(events.length).toBe(25);
    const stkh = events.find((e) => e.symbol === "STKH")!;
    expect(stkh.reasonCode).toBe("T1");
    expect(stkh.reasonText).toBe("News Pending");
    expect(stkh.score).toBe(3);
    expect(stkh.haltTime).toBe("19:50:00"); // millis stripped
    expect(stkh.eventIso).toBe("2026-07-24T23:50:00.000Z"); // 19:50 EDT
    expect(stkh.name).toBe("Steakholder Foods Ltd. ADS");
  });

  it("nyse: CSV with the triple-quote artifact parses to clean names and prose reasons", () => {
    const events = parseNyseHalts(NYSE_FIXTURE);
    expect(events.length).toBeGreaterThan(10);
    const sbev = events.find((e) => e.symbol === "SBEV")!;
    expect(sbev.name).toBe("Splash Beverage Group, Inc."); // quotes fully stripped
    expect(sbev.reasonText).toBe("Corporate Action");
    expect(sbev.score).toBe(1); // corporate actions are lake noise
    expect(sbev.eventIso).toBe("2026-07-24T23:50:38.000Z"); // ISO date input path
  });

  it("draft: symbol, exchange-stated reason, ET time — all parsed", () => {
    const stkh = parseNasdaqHalts(NASDAQ_FIXTURE).find((e) => e.symbol === "STKH")!;
    expect(draftHalt(stkh)).toBe("HALT: STKH (Steakholder Foods Ltd. ADS). News Pending, 19:50 ET");
  });
});

describe("bls calendar + cpi parsing (live fixtures)", () => {
  it("parses the ics with DST-correct ET->UTC conversion", () => {
    const events = parseBlsIcs(ICS_FIXTURE);
    expect(events.length).toBeGreaterThan(200);
    const tracked = events.filter((e) => RELEASES[e.summary]);
    expect(tracked.length).toBeGreaterThan(40);
    // December CPI event: 08:30 EST = 13:30Z (verified fixture event).
    expect(tracked.some((e) => e.summary === "Consumer Price Index" && e.scheduledUtcIso === "2026-12-10T13:30:00.000Z")).toBe(true);
    // An EDT-season CPI lands at 12:30Z (verified: 2026-08-12).
    expect(tracked.some((e) => e.summary === "Consumer Price Index" && e.scheduledUtcIso === "2026-08-12T12:30:00.000Z")).toBe(true);
  });

  it("parses the June 2026 CPI release exactly (verified prose)", () => {
    const h = parseCpiRelease(CPI_FIXTURE)!;
    expect(h).toMatchObject({
      usdl: "26-1191",
      refMonth: "JUNE 2026",
      momVerb: "decreased",
      momPct: 0.4,
      priorVerb: "rising",
      priorPct: 0.5,
      yoyPct: 3.5,
      coreVerb: "was unchanged",
      corePct: null,
    });
  });

  it("draft renders parsed numbers with signs, omitting nothing-parsed pieces", () => {
    const h = parseCpiRelease(CPI_FIXTURE)!;
    expect(draftCpi(h)).toBe("BLS: Consumer Price Index, June 2026: CPI -0.4% m/m, prior +0.5%, core unchanged, +3.5% y/y (USDL-26-1191)");
  });

  it("a verb without its number is never claimed", () => {
    const h = parseCpiRelease(CPI_FIXTURE)!;
    const crippled = { ...h, momPct: null };
    expect(draftCpi(crippled)).not.toContain("m/m");
    expect(draftCpi(crippled)).toContain("prior +0.5%");
  });
});

describe("polls end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const SEND = { calls: [] as Array<Record<string, unknown>> };
  beforeAll(() => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: "/botTEST:TOKEN/sendMessage", method: "POST" })
      .reply(200, (opts) => {
        SEND.calls.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
        return JSON.stringify({ ok: true, result: { message_id: 850 + SEND.calls.length, chat: { id: 424242 } } });
      })
      .persist();
  });

  const FED = "https://www.federalreserve.gov";
  const NQ = "https://www.nasdaqtrader.com";
  const NYSE = "https://www.nyse.com";
  const BLS = "https://www.bls.gov";
  // Fed fixture's newest item is Jul 16; halts fixtures are Jul 24 19:50 ET.
  const FED_NOW = new Date("2026-07-16T20:00:00Z");
  const HALT_NOW = new Date("2026-07-25T00:30:00Z");

  it("fed: ingests, notifies fresh postables, dedups on re-poll", async () => {
    const s0 = SEND.calls.length;
    fetchMock.get(FED).intercept({ path: "/feeds/press_all.xml" }).reply(200, FED_FIXTURE, { headers: { etag: '"f1"' } });
    await pollFedPress(env, FED_NOW);

    // Literal expectation derived from the fixture by hand (2 items inside
    // the 24h window at FED_NOW: one Banking/Consumer 18:00Z, one
    // Enforcement 15:00Z). Computing it with scoreFedItem would move with
    // the implementation — a silent demotion of a whole category would pass.
    expect(SEND.calls.length).toBe(s0 + 2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source='fed_press'").first<{ n: number }>())?.n).toBe(20);

    fetchMock.get(FED).intercept({ path: "/feeds/press_all.xml" }).reply(304, "");
    await pollFedPress(env, FED_NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source='fed_press'").first<{ n: number }>())?.n).toBe(20);
    expect((await getSourceState(env.DB, "fed_press")).consecutiveFailures).toBe(0);
  });

  it("nyse rows are lake-only: its snapshot timestamps disagree with nasdaq's event times", () => {
    const nasdaq = new Map(parseNasdaqHalts(NASDAQ_FIXTURE).map((e) => [e.symbol, e.eventIso]));
    const nyse = parseNyseHalts(NYSE_FIXTURE);
    // Ground truth from the captures: overlapping symbols whose stamps differ.
    const disagreements = nyse.filter((e) => nasdaq.has(e.symbol) && nasdaq.get(e.symbol) !== e.eventIso);
    expect(disagreements.length).toBeGreaterThan(0); // dedup alone cannot be trusted
    // Hence: NOTHING from NYSE is ever postable.
    for (const e of nyse) expect(e.score).toBe(1);
  });

  it("halts: both feeds ingest into ONE source with cross-feed dedup", async () => {
    fetchMock.get(NQ).intercept({ path: "/rss.aspx?feed=tradehalts" }).reply(200, NASDAQ_FIXTURE);
    await pollNasdaqHalts(env, HALT_NOW);
    const afterNasdaq = (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source='halt'").first<{ n: number }>())?.n ?? 0;
    expect(afterNasdaq).toBe(25);

    fetchMock.get(NYSE).intercept({ path: "/api/trade-halts/current/download" }).reply(200, NYSE_FIXTURE);
    await pollNyseHalts(env, HALT_NOW);
    const afterBoth = (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source='halt'").first<{ n: number }>())?.n ?? 0;

    // Overlap verified in the capture (SGLY/STKH etc. in both feeds): the
    // combined count is LESS than the naive sum.
    const nyseCount = parseNyseHalts(NYSE_FIXTURE).length;
    expect(afterBoth).toBeLessThan(25 + nyseCount);
    expect(afterBoth).toBeGreaterThan(25);
  });

  it("halts: an HTML challenge page (zero events) is unhealthy and stores no validators", async () => {
    fetchMock.get(NQ).intercept({ path: "/rss.aspx?feed=tradehalts" }).reply(200, "<html>challenge</html>", { headers: { etag: '"junk"' } });
    await pollNasdaqHalts(env, HALT_NOW);
    const state = await getSourceState(env.DB, "halts_nasdaq");
    expect(state.consecutiveFailures).toBe(1);
    expect(state.etag).toBeNull();
  });

  it("bls: calendar sync fills release_calendar and arms the watcher's due_at", async () => {
    const NOW = new Date("2026-08-01T12:00:00Z");
    await env.DB.prepare("UPDATE jobs SET due_at = '2026-08-01T18:00:00.000Z' WHERE name = 'bls_watch'").run();
    fetchMock.get(BLS).intercept({ path: "/schedule/news_release/bls.ics" }).reply(200, ICS_FIXTURE, { headers: { etag: '"ics1"' } });

    await syncBlsCalendar(env, NOW);

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM release_calendar WHERE source='bls'").first<{ n: number }>();
    expect(n?.n).toBeGreaterThan(10); // future tracked releases only
    // Watcher re-pointed at the next release minus 90s (JOLTS 2026-08-04 14:00Z).
    const due = await env.DB.prepare("SELECT due_at FROM jobs WHERE name='bls_watch'").first<{ due_at: string }>();
    expect(due?.due_at).toBe("2026-08-04T13:58:30.000Z");
  });

  it("bls: the FIRST ever run primes the cursor and posts NOTHING (no stale print)", async () => {
    const s0 = SEND.calls.length;
    const scheduled = "2026-08-12T12:30:00.000Z";
    await env.DB.prepare(
      "INSERT OR IGNORE INTO release_calendar (source, release_name, scheduled_at) VALUES ('bls', 'Consumer Price Index', ?1)",
    )
      .bind(scheduled)
      .run();
    fetchMock.get(BLS).intercept({ path: "/news.release/cpi.nr0.htm" }).reply(200, CPI_FIXTURE).persist();

    await watchBls(env, new Date(scheduled));

    expect(SEND.calls.length).toBe(s0); // last month's print must not post
    expect((await getSourceState(env.DB, "bls_cpi")).cursor).toBe("26-1191");
    const row = await env.DB.prepare("SELECT fired_at FROM release_calendar WHERE scheduled_at = ?1")
      .bind(scheduled)
      .first<{ fired_at: string | null }>();
    expect(row?.fired_at).toBeNull(); // the real print is still awaited
  });

  it("bls: a primed watcher detects the USDL flip and posts within the same run", async () => {
    const s0 = SEND.calls.length;
    const scheduled = "2026-08-12T12:30:00.000Z";
    // Cursor already primed from the pre-release page (previous month's id):
    // this run sees the FLIP, which is the only thing that may post.
    const { putSourceState: put } = await import("../src/lib/db");
    const primed = await getSourceState(env.DB, "bls_cpi");
    primed.cursor = "26-1000";
    await put(env.DB, primed);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO release_calendar (source, release_name, scheduled_at) VALUES ('bls', 'Consumer Price Index', ?1)",
    )
      .bind(scheduled)
      .run();

    fetchMock.get(BLS).intercept({ path: "/news.release/cpi.nr0.htm" }).reply(200, CPI_FIXTURE);
    await watchBls(env, new Date(scheduled)); // waitMs <= 0 -> no sleep

    expect(SEND.calls.length).toBe(s0 + 1);
    expect(String(SEND.calls.at(-1)?.text)).toContain("per BLS");
    const fired = await env.DB.prepare(
      "SELECT fired_at, armed FROM release_calendar WHERE source='bls' AND scheduled_at = ?1",
    )
      .bind(scheduled)
      .first<{ fired_at: string | null; armed: number }>();
    expect(fired?.fired_at).not.toBeNull();
    expect(fired?.armed).toBe(1);
    expect((await getSourceState(env.DB, "bls_cpi")).cursor).toBe("26-1191");

    // Re-run in the same window: cursor unchanged, nothing re-fires.
    await watchBls(env, new Date(new Date(scheduled).getTime() + 60_000));
    expect(SEND.calls.length).toBe(s0 + 1);
  });

  it("bls: an unchanged USDL within the deadline gives up loudly and never posts", async () => {
    const scheduled = "2026-09-11T12:30:00.000Z";
    await env.DB.prepare(
      "INSERT OR IGNORE INTO release_calendar (source, release_name, scheduled_at) VALUES ('bls', 'Consumer Price Index', ?1)",
    )
      .bind(scheduled)
      .run();
    // Pre-seed the cursor to the fixture's USDL: page never "flips".
    const state = await getSourceState(env.DB, "bls_cpi");
    state.cursor = "26-1191";
    const { putSourceState } = await import("../src/lib/db");
    await putSourceState(env.DB, state);

    const s0 = SEND.calls.length;
    fetchMock.get(BLS).intercept({ path: "/news.release/cpi.nr0.htm" }).reply(200, CPI_FIXTURE).persist();
    // Poll starts 5 min after schedule; deadline (300ms in tests) expires.
    await watchBls(env, new Date(new Date(scheduled).getTime() + 300_000));

    expect(SEND.calls.length).toBe(s0);
    const row = await env.DB.prepare(
      "SELECT fired_at, armed FROM release_calendar WHERE source='bls' AND scheduled_at = ?1",
    )
      .bind(scheduled)
      .first<{ fired_at: string | null; armed: number }>();
    expect(row?.fired_at).toBeNull();
    expect(row?.armed).toBe(1); // given up, will not silently re-trigger
  });
});

describe("watcher pre-release sleep", () => {
  it("waits out the gap to the scheduled second, then detects the flip", async () => {
    const scheduled = new Date(Date.now() + 400).toISOString(); // 400ms out
    const { putSourceState: put } = await import("../src/lib/db");
    const primed = await getSourceState(env.DB, "bls_cpi");
    primed.cursor = "26-1000";
    await put(env.DB, primed);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO release_calendar (source, release_name, scheduled_at) VALUES ('bls', 'Consumer Price Index', ?1)",
    )
      .bind(scheduled)
      .run();
    fetchMock.activate();
    fetchMock.get("https://www.bls.gov").intercept({ path: "/news.release/cpi.nr0.htm" }).reply(200, CPI_FIXTURE).persist();

    const started = Date.now();
    // `now` is BEFORE the scheduled instant: the sleep branch runs.
    await watchBls(env, new Date());
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);

    const row = await env.DB.prepare("SELECT fired_at FROM release_calendar WHERE scheduled_at = ?1")
      .bind(scheduled)
      .first<{ fired_at: string | null }>();
    expect(row?.fired_at).not.toBeNull();
  });
});

describe("zonedTimeToUtc", () => {
  it("resolves ET wall clock across both DST regimes", () => {
    expect(zonedTimeToUtc(ET, 2026, 8, 12, 8, 30).toISOString()).toBe("2026-08-12T12:30:00.000Z"); // EDT
    expect(zonedTimeToUtc(ET, 2026, 12, 10, 8, 30).toISOString()).toBe("2026-12-10T13:30:00.000Z"); // EST
  });
});
