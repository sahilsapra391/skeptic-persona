import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// Tests run inside workerd (no fs); Vite inlines the fixture at build time.
import RAW_FIXTURE from "./fixtures/edgar-8k-current.atom.xml?raw";
import {
  draftFor,
  EDGAR_8K_FEED,
  EDGAR_8K_FEED_PAGE2,
  type Edgar8kEntry,
  isFreshAtIngest,
  MAX_ENQUEUES_PER_RUN,
  parse8kFeed,
  pollEdgar8k,
  scoreEntry,
} from "../src/ingesters/edgar8k";
import { getSourceState, putSourceState, SCORE_POSTABLE } from "../src/lib/db";

// Live fixture captured 2026-07-27T00:57Z (see docs/verification/). This IS
// the parse contract: if EDGAR changes shape, this file gets re-captured and
// the diff shows exactly what moved.
const FIXTURE: string = RAW_FIXTURE;

const entry = (over: Partial<Edgar8kEntry>): Edgar8kEntry => ({
  accession: "0000000000-26-000001",
  company: "TEST CORP",
  cik: "0000000001",
  formType: "8-K",
  indexUrl: "https://www.sec.gov/Archives/x-index.htm",
  filedIso: "2026-07-24T21:30:36.000Z",
  items: [],
  ...over,
});

describe("parse8kFeed (live fixture)", () => {
  const parsed = parse8kFeed(FIXTURE);

  it("parses every entry with unique accessions", () => {
    expect(parsed.length).toBe(40);
    expect(new Set(parsed.map((e) => e.accession)).size).toBe(40);
  });

  it("extracts the verified first-entry fields exactly", () => {
    const first = parsed[0]!;
    expect(first.accession).toBe("0001654954-26-006883");
    expect(first.company).toBe("PEDEVCO CORP");
    expect(first.cik).toBe("0001141197");
    expect(first.formType).toBe("8-K");
    expect(first.indexUrl).toBe(
      "https://www.sec.gov/Archives/edgar/data/1141197/000165495426006883/0001654954-26-006883-index.htm",
    );
    // <updated> is ET-offset; normalized to UTC.
    expect(first.filedIso).toBe("2026-07-24T21:30:36.000Z");
    expect(first.items.map((i) => i.code)).toEqual(["5.02", "9.01"]);
    expect(first.items[0]?.title).toMatch(/^Departure of Directors/);
  });

  it("distinguishes 8-K/A amendments via the category term", () => {
    const amendments = parsed.filter((e) => e.formType === "8-K/A");
    expect(amendments.length).toBe(1);
  });

  it("every entry carries an sec.gov index URL, a UTC timestamp, and a parsed CIK", () => {
    for (const e of parsed) {
      expect(e.indexUrl).toMatch(/^https:\/\/www\.sec\.gov\/Archives\//);
      expect(e.filedIso).toMatch(/Z$/);
      expect(e.cik).toMatch(/^\d{10}$/);
    }
  });

  it("8-K-family prefix forms (verified: type= is prefix-match) parse without claiming unparsed fields", () => {
    const xml = `<entry>
      <title>8-K12B - Newco Holdings, Inc. (0002012345) (Filer)</title>
      <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/2012345/000201234526000001/0002012345-26-000001-index.htm"/>
      <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-07-24
&lt;br&gt;Item 5.02: Departure of Directors or Certain Officers</summary>
      <updated>2026-07-24T10:00:00-04:00</updated>
      <category scheme="https://www.sec.gov/" label="form type" term="8-K12B"/>
      <id>urn:tag:sec.gov,2008:accession-number=0002012345-26-000001</id>
    </entry>`;
    const [e] = parse8kFeed(xml);
    expect(e?.formType).toBe("8-K12B");
    expect(e?.cik).toBe(""); // TITLE_RE deliberately narrow; unparsed stays unclaimed
  });
});

describe("scoreEntry", () => {
  it("scores by the highest-grade item", () => {
    expect(scoreEntry(entry({ items: [{ code: "4.02", title: "t" }] }))).toBe(3);
    expect(scoreEntry(entry({ items: [{ code: "5.02", title: "t" }, { code: "9.01", title: "t" }] }))).toBe(3);
    expect(scoreEntry(entry({ items: [{ code: "2.02", title: "t" }, { code: "9.01", title: "t" }] }))).toBe(2);
    expect(scoreEntry(entry({ items: [{ code: "7.01", title: "t" }] }))).toBe(1);
    expect(scoreEntry(entry({ items: [{ code: "9.01", title: "t" }] }))).toBe(0);
  });

  it("covers the full current SEC item roster without unknown-code warnings", () => {
    // Every code that appears in the live fixture must be a known code.
    for (const e of parse8kFeed(FIXTURE)) {
      for (const i of e.items) {
        expect(["0", "1", "2", "3"]).toContain(String(scoreEntry(entry({ items: [i] }))));
      }
    }
    // Roster spot-checks for codes added by review: mine safety, blackout, ABS.
    expect(scoreEntry(entry({ items: [{ code: "1.04", title: "t" }] }))).toBe(1);
    expect(scoreEntry(entry({ items: [{ code: "5.04", title: "t" }] }))).toBe(1);
    expect(scoreEntry(entry({ items: [{ code: "6.03", title: "t" }] }))).toBe(1);
  });

  it("no parsed items -> log-only, never postable", () => {
    expect(scoreEntry(entry({ items: [] }))).toBe(1);
  });

  it("unknown item codes -> log-only, never postable", () => {
    expect(scoreEntry(entry({ items: [{ code: "12.34", title: "future thing" }] }))).toBe(1);
  });

  it("a missing CIK (unparsed title) clamps to log-only regardless of items", () => {
    expect(scoreEntry(entry({ cik: "", items: [{ code: "5.02", title: "t" }] }))).toBe(1);
  });

  it("amendments (any /A suffix) are capped at log-only in the pilot", () => {
    expect(scoreEntry(entry({ formType: "8-K/A", items: [{ code: "4.02", title: "t" }] }))).toBe(1);
    expect(scoreEntry(entry({ formType: "8-K12B/A", items: [{ code: "4.02", title: "t" }] }))).toBe(1);
  });
});

describe("isFreshAtIngest", () => {
  const now = new Date("2026-07-27T12:00:00Z");
  it("accepts items inside the window and rejects backfill", () => {
    expect(isFreshAtIngest("2026-07-27T10:00:00.000Z", now)).toBe(true);
    expect(isFreshAtIngest("2026-07-24T21:30:36.000Z", now)).toBe(false); // Friday filing seen Monday
  });
  it("no parsed timestamp -> not claimable as fresh", () => {
    expect(isFreshAtIngest("", now)).toBe(false);
  });
});

describe("draftFor", () => {
  it("head uses the PARSED form type, never a hardcoded label", () => {
    const d = draftFor(
      entry({
        company: "ACME CORP",
        formType: "8-K/A",
        items: [{ code: "5.02", title: "Departure of Directors or Certain Officers" }],
      }),
    );
    expect(d).toBe("8-K/A: ACME CORP\nItem 5.02 — Departure of Directors or Certain Officers");
  });

  it("drops exhibit-only noise but keeps 9.01 when it is the only item", () => {
    const d = draftFor(
      entry({
        company: "ACME CORP",
        items: [
          { code: "5.02", title: "Departure of Directors or Certain Officers" },
          { code: "9.01", title: "Financial Statements and Exhibits" },
        ],
      }),
    );
    expect(d).toBe("8-K: ACME CORP\nItem 5.02 — Departure of Directors or Certain Officers");
    expect(draftFor(entry({ items: [{ code: "9.01", title: "Financial Statements and Exhibits" }] }))).toContain(
      "Item 9.01",
    );
  });
});

describe("pollEdgar8k end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const SEC = "https://www.sec.gov";
  const FEED_PATH = EDGAR_8K_FEED.replace(SEC, "");
  const PAGE2_PATH = EDGAR_8K_FEED_PAGE2.replace(SEC, "");
  // Within STALE_AT_INGEST_HOURS of every fixture entry (filed Fri 20:51-21:30Z),
  // so the freshness gate sees them all as live news.
  const NOW = new Date("2026-07-25T06:00:00Z");

  // File-level persistent Telegram counter (see webhook.test.ts for why
  // counters, not pending-interceptor checks, are used for negative proofs).
  const SEND = { calls: [] as Array<Record<string, unknown>> };
  beforeAll(() => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: "/botTEST:TOKEN/sendMessage", method: "POST" })
      .reply(200, (opts) => {
        SEND.calls.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
        return JSON.stringify({ ok: true, result: { message_id: 600 + SEND.calls.length, chat: { id: 424242 } } });
      })
      .persist();
  });

  function mockFeed(body: string, opts: { headers?: Record<string, string>; status?: number; path?: string } = {}): void {
    fetchMock
      .get(SEC)
      .intercept({ path: opts.path ?? FEED_PATH })
      .reply(opts.status ?? 200, body, {
        headers: { "content-type": "text/html; charset=utf-8", ...opts.headers },
      });
  }

  it("ingests, dedups, drains through the cap with distinct items, and marks sub-postables 'logged'", async () => {
    const parsed = parse8kFeed(FIXTURE);
    const postable = parsed.filter((e) => scoreEntry(e) >= SCORE_POSTABLE && isFreshAtIngest(e.filedIso, NOW)).length;
    // Contract guard for future fixture re-captures: the cap/drain assertions
    // below are vacuous unless the fixture holds more postables than the cap.
    expect(postable).toBeGreaterThan(MAX_ENQUEUES_PER_RUN);

    const s0 = SEND.calls.length;
    mockFeed(FIXTURE, { headers: { etag: '"feed-v1"' } });
    await pollEdgar8k(env, NOW);

    const items = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'edgar_8k'").first<{ n: number }>();
    expect(items?.n).toBe(40);
    expect(SEND.calls.length - s0).toBe(MAX_ENQUEUES_PER_RUN);
    expect(String(SEND.calls.at(-1)?.text)).toMatch(/8-K/);

    // Sub-postable items are 'logged', not 'new' (drain-set stays bounded).
    const logged = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE source = 'edgar_8k' AND status = 'logged'",
    ).first<{ n: number }>();
    expect(logged?.n).toBe(40 - postable);

    const state1 = await getSourceState(env.DB, "edgar_8k");
    expect(state1.etag).toBe('"feed-v1"');
    expect(state1.cursor).toBe("0001654954-26-006883");
    expect(state1.consecutiveFailures).toBe(0);

    // Second poll: identical feed -> zero new items; the drain continues with
    // the NEXT batch (distinct items, not re-sends of the first ten).
    mockFeed(FIXTURE);
    await pollEdgar8k(env, NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'edgar_8k'").first<{ n: number }>())?.n).toBe(40);
    expect(SEND.calls.length - s0).toBe(postable); // 20 in the fixture: 10 + 10

    const q = await env.DB.prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT item_id) AS distinct_items
       FROM queue WHERE archetype = 'FILING_ALERT'`,
    ).first<{ total: number; distinct_items: number }>();
    expect(q?.total).toBe(postable);
    expect(q?.distinct_items).toBe(postable); // identity, not just count
  });

  it("conditional GET round-trips validators; 304 short-circuits but still drains", async () => {
    // Seed state via a real 200 with an etag.
    mockFeed(FIXTURE, { headers: { etag: '"cond-v1"' } });
    await pollEdgar8k(env, NOW);
    const drainedSoFar = SEND.calls.length;

    // Next poll must SEND If-None-Match and honor the 304.
    let seenINM: string | null = null;
    fetchMock
      .get(SEC)
      .intercept({ path: FEED_PATH })
      .reply(304, (opts: { headers: unknown }) => {
        const h = opts.headers;
        seenINM = Array.isArray(h)
          ? String(h[(h as string[]).findIndex((x) => String(x).toLowerCase() === "if-none-match") + 1] ?? "")
          : ((h as Record<string, string>)["if-none-match"] ?? (h as Record<string, string>)["If-None-Match"] ?? null);
        return "";
      });
    await pollEdgar8k(env, NOW);

    expect(seenINM).toBe('"cond-v1"');
    const state = await getSourceState(env.DB, "edgar_8k");
    expect(state.etag).toBe('"cond-v1"');
    expect(state.consecutiveFailures).toBe(0);
    // The 304 path still drains leftover postables (10 remained after poll 1).
    expect(SEND.calls.length).toBe(drainedSoFar + MAX_ENQUEUES_PER_RUN);
  });

  it("zero entries on a 200 is treated as unhealthy, not as a quiet feed", async () => {
    const s0 = SEND.calls.length;
    mockFeed("<html>EDGAR will be back shortly</html>", { headers: { etag: '"junk"' } });
    await pollEdgar8k(env, NOW);

    const state = await getSourceState(env.DB, "edgar_8k");
    expect(state.consecutiveFailures).toBe(1);
    expect(state.etag).toBeNull(); // junk validators never stored
    expect(state.lastOkAt).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>())?.n).toBe(0);
    expect(SEND.calls.length).toBe(s0);
  });

  it("network throws and non-2xx both count consecutive failures; success resets", async () => {
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).replyWithError(new Error("connect timeout"));
    await pollEdgar8k(env, NOW);
    expect((await getSourceState(env.DB, "edgar_8k")).consecutiveFailures).toBe(1);

    mockFeed("unavailable", { status: 503 });
    await pollEdgar8k(env, NOW);
    const after = await getSourceState(env.DB, "edgar_8k");
    expect(after.consecutiveFailures).toBe(2);
    expect(after.lastOkAt).toBeNull();

    mockFeed(FIXTURE);
    await pollEdgar8k(env, NOW);
    const healed = await getSourceState(env.DB, "edgar_8k");
    expect(healed.consecutiveFailures).toBe(0);
    expect(healed.lastOkAt).not.toBeNull();
  });

  it("window overflow (cursor scrolled off page 1) triggers a bounded page-2 fetch", async () => {
    // Prior poll saw an accession that is NOT in the current page.
    const state = await getSourceState(env.DB, "edgar_8k");
    state.cursor = "9999999999-26-999999";
    await putSourceState(env.DB, state);

    const page2 = `<feed><entry>
      <title>8-K - OVERFLOW CO (0009999999) (Filer)</title>
      <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/9999999/000999999926000001/0009999999-26-000001-index.htm"/>
      <summary type="html">&lt;br&gt;Item 2.02: Results of Operations and Financial Condition</summary>
      <updated>2026-07-24T16:05:00-04:00</updated>
      <category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
      <id>urn:tag:sec.gov,2008:accession-number=0009999999-26-000001</id>
    </entry></feed>`;

    mockFeed(FIXTURE);
    mockFeed(page2, { path: PAGE2_PATH });
    await pollEdgar8k(env, NOW);

    const overflowItem = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE external_id = '0009999999-26-000001'",
    ).first<{ n: number }>();
    expect(overflowItem?.n).toBe(1); // page 2 was fetched and ingested
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source='edgar_8k'").first<{ n: number }>())?.n).toBe(41);
  });
});
