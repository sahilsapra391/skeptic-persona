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
