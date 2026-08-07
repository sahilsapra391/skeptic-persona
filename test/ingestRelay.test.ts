import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import TREASURY from "./fixtures/treasury-auctions.json?raw";
import CFTC from "./fixtures/cftc-enforcement.xml.fixture?raw";
import { INGEST_PATH, RELAY_SOURCES } from "../src/ingestRelay";
import { SOURCE as TREASURY_SOURCE } from "../src/ingesters/treasury";

const URL_BASE = "https://worker.local";
const SECRET = "test-ingest-secret";

function post(body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Ingest-Secret"] = secret;
  return SELF.fetch(`${URL_BASE}${INGEST_PATH}`, { method: "POST", headers, body: JSON.stringify(body) });
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe("ingest relay auth", () => {
  it("rejects a missing or wrong secret without touching state", async () => {
    expect((await post({ source: TREASURY_SOURCE, body: TREASURY }, null)).status).toBe(401);
    expect((await post({ source: TREASURY_SOURCE, body: TREASURY }, "wrong")).status).toBe(401);
    // Equal length, last byte differs: exercises the timing-safe compare
    // itself rather than the length-mismatch early return.
    expect((await post({ source: TREASURY_SOURCE, body: TREASURY }, "test-ingest-secreT")).status).toBe(401);

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1")
      .bind(TREASURY_SOURCE)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("ingest relay validation", () => {
  it("rejects malformed bodies and unknown sources", async () => {
    expect((await post({ source: TREASURY_SOURCE }, SECRET)).status).toBe(400);
    expect((await post({ body: "x" }, SECRET)).status).toBe(400);
    expect((await post({ source: TREASURY_SOURCE, body: "" }, SECRET)).status).toBe(400);
    // A source the Worker does not know is a courier/Worker deploy mismatch.
    expect((await post({ source: "not_a_source", body: "x" }, SECRET)).status).toBe(400);
  });

  it("returns 422 with the reason when the body does not parse", async () => {
    const res = await post({ source: TREASURY_SOURCE, body: "not json at all" }, SECRET);
    // A silent 200 would let the courier think it succeeded forever.
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/error/i);
  });

  it("only relays sources that are actually blocked from Worker egress", () => {
    expect(RELAY_SOURCES.has(TREASURY_SOURCE)).toBe(true);
    expect(RELAY_SOURCES.has("press_cftc_enforcement")).toBe(true);
    // Reachable sources must keep polling directly; relaying them would
    // duplicate ingestion.
    expect(RELAY_SOURCES.has("edgar_8k")).toBe(false);
    expect(RELAY_SOURCES.has("halt")).toBe(false);
  });
});

describe("ingest relay ingestion", () => {
  it("parses Treasury with the SAME parser the Worker uses, and dedups", async () => {
    const first = await post({ source: TREASURY_SOURCE, body: TREASURY }, SECRET);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { ok: boolean; inserted: number };
    expect(body.ok).toBe(true);
    expect(body.inserted).toBeGreaterThan(0);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1")
      .bind(TREASURY_SOURCE)
      .first<{ n: number }>();
    expect(rows?.n).toBe(body.inserted);

    // Re-delivering the same payload must not duplicate: the courier has no
    // memory and will resend on retry.
    const second = await post({ source: TREASURY_SOURCE, body: TREASURY }, SECRET);
    const secondBody = (await second.json()) as { inserted: number };
    expect(secondBody.inserted).toBe(0);
  });

  it("parses a relayed CFTC press feed", async () => {
    const res = await post({ source: "press_cftc_enforcement", body: CFTC }, SECRET);
    expect(res.status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = 'press_cftc_enforcement'").first<{
      n: number;
    }>();
    expect(n?.n).toBeGreaterThan(0);
  });
});

describe("D-71: a relayed source records its own health", () => {
  // Before this, the handler inserted rows and drained without ever writing
  // source_state, so a courier-fed source kept whatever the last DIRECT poll
  // left behind. On 2026-08-07 the senate row read
  // `consecutive_failures=5, last_error="efd home 403", last_ok=08-02` while
  // 18 filings were landing through this exact path, and that stale row is
  // what the previous diagnosis was built on.

  it("clears failures and stamps last_ok after a successful relay", async () => {
    // Seed the row in the exact broken state production was found in.
    await env.DB.prepare(
      `INSERT INTO source_state (source, consecutive_failures, last_error, last_ok_at)
       VALUES ('senate_ptr', 5, 'Error: efd home 403', '2026-08-02T13:30:01.000Z')
       ON CONFLICT(source) DO UPDATE SET
         consecutive_failures = 5,
         last_error = 'Error: efd home 403',
         last_ok_at = '2026-08-02T13:30:01.000Z'`,
    ).run();

    const SEARCH = (await import("./fixtures/senate-ptr-data.json?raw")).default;
    const DETAIL = (await import("./fixtures/senate-ptr-page.fixture?raw")).default;
    const search = JSON.parse(SEARCH) as { data: string[][] };
    const details: Record<string, string> = {};
    for (const row of search.data) {
      const m = /\/search\/view\/ptr\/([0-9a-f-]{36})\//.exec(row[3] ?? "");
      if (m) details[m[1]!] = DETAIL;
    }

    expect((await post({ source: "senate_ptr", body: JSON.stringify({ search, details }) })).status).toBe(200);

    const after = await env.DB.prepare(
      "SELECT consecutive_failures, last_ok_at FROM source_state WHERE source = 'senate_ptr'",
    ).first<{ consecutive_failures: number; last_ok_at: string }>();
    expect(after!.consecutive_failures).toBe(0);
    // The specific stale value must be gone, not merely "some value present".
    expect(after!.last_ok_at).not.toBe("2026-08-02T13:30:01.000Z");
    expect(Date.parse(after!.last_ok_at)).toBeGreaterThan(Date.parse("2026-08-02T13:30:01.000Z"));
  });

  it("records the failure when a relayed body will not parse", async () => {
    await env.DB.prepare(
      `INSERT INTO source_state (source, consecutive_failures, last_error, last_ok_at)
       VALUES ('senate_ptr', 0, NULL, '2026-08-07T00:00:00.000Z')
       ON CONFLICT(source) DO UPDATE SET consecutive_failures = 0, last_error = NULL`,
    ).run();

    // A well-formed envelope carrying a bundle that parses to zero rows.
    const res = await post({ source: "senate_ptr", body: JSON.stringify({ search: { result: "ok", data: [] }, details: {} }) });
    expect(res.status).toBe(422);

    const after = await env.DB.prepare(
      "SELECT consecutive_failures, last_error FROM source_state WHERE source = 'senate_ptr'",
    ).first<{ consecutive_failures: number; last_error: string | null }>();
    expect(after!.consecutive_failures).toBeGreaterThan(0);
    expect(String(after!.last_error)).toContain("zero rows");
  });
});

describe("senate eFD bundle", () => {
  it("ingests a courier bundle through the SAME parsers as the direct poller", async () => {
    const SEARCH = (await import("./fixtures/senate-ptr-data.json?raw")).default;
    const DETAIL = (await import("./fixtures/senate-ptr-page.fixture?raw")).default;
    const search = JSON.parse(SEARCH) as { data: string[][] };
    // Map every electronic row's uuid to the one detail fixture we have.
    const details: Record<string, string> = {};
    for (const row of search.data) {
      const m = /\/search\/view\/ptr\/([0-9a-f-]{36})\//.exec(row[3] ?? "");
      if (m) details[m[1]!] = DETAIL;
    }

    const res = await post(
      { source: "senate_ptr", body: JSON.stringify({ search, details }) },
      SECRET,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number };
    expect(body.inserted).toBeGreaterThan(0);

    const row = await env.DB.prepare(
      "SELECT payload FROM items WHERE source = 'senate_ptr' AND json_extract(payload,'$.kind') = 'ptr' LIMIT 1",
    ).first<{ payload: string }>();
    expect(row).toBeTruthy();
    const p = JSON.parse(row!.payload) as Record<string, unknown>;
    // Proof the shared ingest path ran: these fields only exist because
    // parsePtrTable and draftSenatePtr were applied.
    expect(Array.isArray(p.transactions)).toBe(true);
    expect(String(p.factLine)).toContain("Senate PTR");
    expect(p.amountBand).toBeTruthy();
  });

  it("skips a filing whose detail page the courier could not fetch", async () => {
    const SEARCH = (await import("./fixtures/senate-ptr-data.json?raw")).default;
    const search = JSON.parse(SEARCH) as { data: string[][] };
    // Empty details map: the courier was rate-limited mid-run.
    const res = await post({ source: "senate_ptr", body: JSON.stringify({ search, details: {} }) }, SECRET);
    expect(res.status).toBe(200);

    const ptrRows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE source = 'senate_ptr' AND json_extract(payload,'$.kind') = 'ptr'",
    ).first<{ n: number }>();
    // An item inserted without its transactions would look complete while
    // claiming nothing, so a missing detail page is skipped rather than
    // guessed at. (Paper filings have no table and still land in the lake.)
    expect(ptrRows?.n).toBe(0);
  });

  it("rejects a bundle whose search payload is unusable", async () => {
    const res = await post({ source: "senate_ptr", body: JSON.stringify({ search: { result: "fail" }, details: {} }) }, SECRET);
    expect(res.status).toBe(422);
  });
});
