import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import SENATE_DATA from "./fixtures/senate-ptr-data.json?raw";
import SENATE_PAGE from "./fixtures/senate-ptr-page.fixture?raw";
import {
  draftSenatePtr,
  efdDateToIso,
  type EfdRow,
  parseEfdRows,
  parsePtrTable,
  pollSenatePtr,
} from "../src/ingesters/senatePtr";
import { houseDateToIso, parseHouseIndex, pollHousePtr } from "../src/ingesters/housePtr";
import { unzipEntry } from "../src/lib/zip";
import { getSourceState } from "../src/lib/db";
import { newTickBudget } from "../src/lib/budget";

// ZIP fixtures are committed as .b64 twins (the workers pool can't import
// binary modules), and the HTML capture carries a .fixture suffix: miniflare
// force-loads any filename containing ".html"/".txt" through a broken
// Text-module path, while unrecognized extensions fall through to Vite ?raw.
import HOUSE_ZIP_B64 from "./fixtures/house-2026FD.zip.b64?raw";
import HOUSE_EMPTY_ZIP_B64 from "./fixtures/house-empty.zip.b64?raw";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const HOUSE_ZIP = b64ToBytes(HOUSE_ZIP_B64);
const HOUSE_EMPTY_ZIP = b64ToBytes(HOUSE_EMPTY_ZIP_B64);

describe("senate parsers (live fixtures)", () => {
  it("parses the DataTables rows: 11 records, Moreno PTR first", () => {
    const rows = parseEfdRows(JSON.parse(SENATE_DATA));
    expect(rows.length).toBe(11);
    expect(rows[0]).toMatchObject({
      firstName: "Bernie",
      lastName: "Moreno",
      display: "Moreno, Bernardo (Senator)",
      kind: "ptr",
      uuid: "bccf83ce-dd72-4ab6-8564-b3bbb1d2ee55",
      filedDate: "07/24/2026",
    });
  });

  it("parses the PTR table with VERBATIM amount bands and nested-div stripping", () => {
    const txns = parsePtrTable(SENATE_PAGE);
    expect(txns.length).toBe(2);
    expect(txns[0]).toMatchObject({
      transactionDate: "06/24/2026",
      owner: "Self",
      ticker: null, // '--' as served
      assetType: "Other",
      type: "Sale (Full)",
      amount: "$1,001 - $15,000",
    });
    expect(txns[0]?.assetName).toMatch(/^BofA Finance LLC Trigger Autocallable/);
    expect(txns[1]?.transactionDate).toBe("06/22/2026");
  });

  it("date conversion and the disclosure-lag editorial", () => {
    expect(efdDateToIso("07/24/2026")).toBe("2026-07-24T00:00:00.000Z");
    expect(efdDateToIso("7/4/2026")).toBe("2026-07-04T00:00:00.000Z");
    const row: EfdRow = {
      firstName: "Bernie",
      lastName: "Moreno",
      display: "Moreno, Bernardo (Senator)",
      kind: "ptr",
      uuid: "u",
      filedDate: "07/24/2026",
    };
    const draft = draftSenatePtr(row, parsePtrTable(SENATE_PAGE), efdDateToIso("07/24/2026"));
    expect(draft).toContain("Senate PTR: Moreno, Bernardo.");
    expect(draft).toContain("Sale (Full) $1,001 - $15,000");
    expect(draft).toContain("disclosed 30 days after the latest trade"); // 06/24 -> 07/24, parsed dates only
    // Attribution is appended by the template engine, not the fact builder.
    expect(draft).not.toContain("per Senate");
    expect(draft).not.toContain("(Senator)");
  });
});

describe("house parsers (live fixtures)", () => {
  it("unzips the real Clerk index and parses exactly the P rows", async () => {
    const txt = new TextDecoder().decode(await unzipEntry(HOUSE_ZIP, "2026FD.txt"));
    const { rows, totalDataLines } = parseHouseIndex(txt);
    expect(rows.length).toBe(313); // fixture ground truth
    expect(totalDataLines).toBeGreaterThan(1000); // all filing types counted
    const yakym = rows.find((r) => r.docId === "20034984");
    expect(yakym).toMatchObject({
      member: "Rudy C. Yakym III",
      stateDst: "IN02",
      filedDate: "7/13/2026",
      efiled: true,
    });
    // 7-digit DocIDs are the (likely scanned) paper family.
    expect(rows.some((r) => !r.efiled)).toBe(true);
  });

  it("date conversion handles the no-leading-zeros format", () => {
    expect(houseDateToIso("7/13/2026")).toBe("2026-07-13T00:00:00.000Z");
    expect(houseDateToIso("12/1/2026")).toBe("2026-12-01T00:00:00.000Z");
    expect(houseDateToIso("garbage")).toBe("");
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
        return JSON.stringify({ ok: true, result: { message_id: 800 + SEND.calls.length, chat: { id: 424242 } } });
      })
      .persist();
  });

  const EFD = "https://efdsearch.senate.gov";
  const HOME_BODY = `<html><form><input type="hidden" name="csrfmiddlewaretoken" value="HIDDEN64"></form></html>`;
  const NOW = new Date("2026-07-24T18:00:00Z"); // filed 07/24 -> fresh at ingest

  function mockHandshake(): void {
    fetchMock
      .get(EFD)
      .intercept({ path: "/search/home/", method: "GET" })
      .reply(200, HOME_BODY, {
        headers: { "set-cookie": ["csrftoken=CT123; Path=/; Secure", "33aa=LB1; Path=/"] as unknown as string },
      });
    fetchMock
      .get(EFD)
      .intercept({ path: "/search/home/", method: "POST" })
      .reply(302, "", { headers: { "set-cookie": "sessionid=S1; Path=/; HttpOnly", location: "/search/" } });
  }

  const dataJson = (rows: string[][]): string => JSON.stringify({ result: "ok", recordsTotal: rows.length, data: rows });
  const MORENO: string[] = [
    "Bernie",
    "Moreno",
    "Moreno, Bernardo (Senator)",
    '<a href="/search/view/ptr/bccf83ce-dd72-4ab6-8564-b3bbb1d2ee55/" target="_blank">Periodic Transaction Report for 07/24/2026</a>',
    "07/24/2026",
  ];
  const PAPER: string[] = [
    "Rich",
    "Sanchez",
    "Senator",
    '<a href="/search/view/paper/3a4c5095-028a-4614-a692-836719da4e63/" target="_blank">Periodic Transaction Report</a>',
    "07/23/2026",
  ];

  it("senate: handshake -> data -> page parse -> postable draft; paper rows lake-only; dedup on re-poll", async () => {
    const s0 = SEND.calls.length;
    mockHandshake();
    fetchMock.get(EFD).intercept({ path: "/search/report/data/", method: "POST" }).reply(200, dataJson([MORENO, PAPER]));
    fetchMock
      .get(EFD)
      .intercept({ path: "/search/view/ptr/bccf83ce-dd72-4ab6-8564-b3bbb1d2ee55/" })
      .reply(200, SENATE_PAGE);

    await pollSenatePtr(env, NOW);

    expect(SEND.calls.length).toBe(s0 + 1);
    expect(String(SEND.calls.at(-1)?.text)).toContain("per Senate financial disclosures");
    const items = await env.DB.prepare(
      "SELECT external_id, status, score FROM items WHERE source = 'senate_ptr' ORDER BY external_id",
    ).all<{ external_id: string; status: string; score: number }>();
    expect(items.results).toEqual([
      { external_id: "3a4c5095-028a-4614-a692-836719da4e63", status: "logged", score: 1 },
      { external_id: "bccf83ce-dd72-4ab6-8564-b3bbb1d2ee55", status: "queued", score: 2 },
    ]);

    // Re-poll: full handshake again, same rows -> no page fetch, no re-send.
    mockHandshake();
    fetchMock.get(EFD).intercept({ path: "/search/report/data/", method: "POST" }).reply(200, dataJson([MORENO, PAPER]));
    await pollSenatePtr(env, NOW);
    expect(SEND.calls.length).toBe(s0 + 1);
    expect((await getSourceState(env.DB, "senate_ptr")).consecutiveFailures).toBe(0);
  });

  it("senate: a 503 'maintenance' data response triggers exactly one fresh-handshake retry", async () => {
    mockHandshake();
    fetchMock.get(EFD).intercept({ path: "/search/report/data/", method: "POST" }).reply(503, "<html>Site Under Maintenance</html>");
    mockHandshake(); // retry handshake
    fetchMock.get(EFD).intercept({ path: "/search/report/data/", method: "POST" }).reply(200, dataJson([]));

    await pollSenatePtr(env, NOW);
    expect((await getSourceState(env.DB, "senate_ptr")).consecutiveFailures).toBe(0);
    // Every mocked step consumed: both handshakes ran (a retry that skipped
    // re-handshaking would leave the second home GET/POST pending).
    fetchMock.assertNoPendingInterceptors();
  });

  it("senate: budget below handshake cost defers the whole poll", async () => {
    await pollSenatePtr(env, NOW, newTickBudget(2)); // needs 3
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'senate_ptr'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  const HOUSE = "https://disclosures-clerk.house.gov";
  const HOUSE_PATH = "/public_disc/financial-pdfs/2026FD.zip";
  const HOUSE_NOW = new Date("2026-07-27T05:00:00Z");

  it("house: ingests all P rows from the real ZIP as lake items with document links", async () => {
    const s0 = SEND.calls.length;
    fetchMock
      .get(HOUSE)
      .intercept({ path: HOUSE_PATH })
      .reply(200, HOUSE_ZIP, { headers: { etag: '"h1"', "last-modified": "Fri, 24 Jul 2026 13:00:40 GMT" } });

    await pollHousePtr(env, HOUSE_NOW);

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'house_ptr'").first<{ n: number }>();
    expect(n?.n).toBe(313);
    const yakym = await env.DB.prepare("SELECT source_url, status, score FROM items WHERE external_id = '20034984'").first<{
      source_url: string;
      status: string;
      score: number;
    }>();
    expect(yakym).toEqual({
      source_url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034984.pdf",
      status: "logged",
      score: 1,
    });
    expect(SEND.calls.length).toBe(s0); // discovery-level: nothing notifies

    const state = await getSourceState(env.DB, "house_ptr");
    expect(state.etag).toBe('"h1"');

    // Conditional re-poll: 304 keeps everything as-is.
    fetchMock.get(HOUSE).intercept({ path: HOUSE_PATH }).reply(304, "");
    await pollHousePtr(env, HOUSE_NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'house_ptr'").first<{ n: number }>())?.n).toBe(313);
  });

  it("house: rows-but-zero-PTRs is healthy sparsity (validators stored), not drift", async () => {
    fetchMock.get(HOUSE).intercept({ path: HOUSE_PATH }).reply(200, HOUSE_EMPTY_ZIP, { headers: { etag: '"sparse"' } });
    await pollHousePtr(env, HOUSE_NOW);
    const state = await getSourceState(env.DB, "house_ptr");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.etag).toBe('"sparse"');
  });

  it("house: January polls the prior year too and tolerates the new year's 404", async () => {
    const JAN = new Date("2027-01-15T12:00:00Z");
    fetchMock.get(HOUSE).intercept({ path: "/public_disc/financial-pdfs/2027FD.zip" }).reply(404, "not yet");
    fetchMock.get(HOUSE).intercept({ path: HOUSE_PATH }).reply(200, HOUSE_ZIP);
    await pollHousePtr(env, JAN);

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'house_ptr'").first<{ n: number }>();
    expect(n?.n).toBe(313); // prior-year file still ingested
    expect((await getSourceState(env.DB, "house_ptr")).consecutiveFailures).toBe(0); // 404 was expected, not a failure
  });
});

describe("date-only freshness (shared)", () => {
  it("grants date-only filings a whole-day allowance (evening filings never self-suppress)", async () => {
    const { isFreshDateOnly } = await import("../src/ingesters/shared");
    // Filed 07/24 (UTC-midnight anchor), first seen 01:30Z on 07/25 — a
    // ~9PM-ET-filed PTR polled hours later. 24h anchoring would call this
    // stale; the date-only rule keeps it fresh.
    expect(isFreshDateOnly("2026-07-24T00:00:00.000Z", new Date("2026-07-25T01:30:00Z"))).toBe(true);
    expect(isFreshDateOnly("2026-07-24T00:00:00.000Z", new Date("2026-07-25T23:00:00Z"))).toBe(true);
    expect(isFreshDateOnly("2026-07-24T00:00:00.000Z", new Date("2026-07-26T01:00:00Z"))).toBe(false);
    expect(isFreshDateOnly("", new Date())).toBe(false);
  });

  it("discovery-anchored freshness: the clock starts when we could first have KNOWN", async () => {
    const { isFreshOnDiscovery, isFreshDateOnly, LATE_DISCOVERY_MAX_FILING_AGE_HOURS } = await import("../src/ingesters/shared");
    const now = new Date("2026-08-06T16:30:00Z");
    // Filing dates are UTC-midnight anchors, so their ages from `now` are
    // fixed and stated rather than computed: 08-05 is 40.5h, 08-04 is 64.5h,
    // 08-03 is 88.5h, 08-02 is 112.5h.
    const seen = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    const D = (d: string) => `2026-08-${d}T00:00:00.000Z`;

    // THE PRODUCTION CASE, and the whole reason this function exists. Filed
    // 64.5h ago, the Clerk's index reached us 1h ago. isFreshDateOnly says
    // stale; this says fresh, because 1h ago is the first moment we could
    // have known. Measured: the old gate resolved false 152 times out of 152
    // in production and no CONGRESS_PTR card has ever existed.
    expect(isFreshOnDiscovery(D("04"), seen(1), now)).toBe(true);
    expect(isFreshDateOnly(D("04"), now)).toBe(false);

    // The discovery window still closes: found 49h ago is stale however
    // recently the filing itself happened.
    expect(isFreshOnDiscovery(D("05"), seen(49), now)).toBe(false);
    expect(isFreshOnDiscovery(D("05"), seen(47), now)).toBe(true);

    // THE FLOOD GUARD, the half that must never widen. A filing older than
    // CONGRESS_PTR's own 96h queue TTL cannot card however freshly we
    // discovered it — otherwise a re-backfill emits ~144 cards from filings
    // up to seven months old.
    expect(LATE_DISCOVERY_MAX_FILING_AGE_HOURS).toBe(96);
    expect(isFreshOnDiscovery(D("03"), seen(0), now)).toBe(true); // 88.5h, inside
    expect(isFreshOnDiscovery(D("02"), seen(0), now)).toBe(false); // 112.5h, outside
    expect(isFreshOnDiscovery("2026-01-05T00:00:00.000Z", seen(0), now)).toBe(false);

    // Fails closed on missing or nonsensical inputs, including a discovery
    // timestamp in the FUTURE — a clock fault must never read as fresh.
    expect(isFreshOnDiscovery("", seen(0), now)).toBe(false);
    expect(isFreshOnDiscovery(D("05"), "", now)).toBe(false);
    expect(isFreshOnDiscovery(D("05"), "not a date", now)).toBe(false);
    expect(isFreshOnDiscovery(D("05"), new Date(now.getTime() + 3_600_000).toISOString(), now)).toBe(false);
  });


});
