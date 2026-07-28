import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSourceState, insertItem, putSourceState, SCORE_POSTABLE,
  recordSourceError,
} from "../src/lib/db";

const item = (externalId: string) => ({
  source: "edgar_8k",
  externalId,
  category: "filing",
  eventAt: "2026-07-24T21:30:36.000Z",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/1141197/000165495426006883/0001654954-26-006883-index.htm",
  payload: { items: ["5.02", "9.01"] },
  score: SCORE_POSTABLE,
});

describe("insertItem dedup", () => {
  it("inserts a new item and reports duplicates on re-insert", async () => {
    const first = await insertItem(env.DB, item("0001654954-26-006883"));
    expect(first.outcome).toBe("inserted");
    expect(first.id).not.toBeNull();

    const second = await insertItem(env.DB, item("0001654954-26-006883"));
    expect(second.outcome).toBe("duplicate");
    expect(second.id).toBeNull();

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("same external id from different sources does not collide", async () => {
    expect((await insertItem(env.DB, item("X-1"))).outcome).toBe("inserted");
    expect((await insertItem(env.DB, { ...item("X-1"), source: "edgar_form4" })).outcome).toBe("inserted");
  });

  it("stores payload as JSON with parsed fields only", async () => {
    await insertItem(env.DB, item("J-1"));
    const row = await env.DB.prepare("SELECT payload, status, score FROM items WHERE external_id = 'J-1'").first<{
      payload: string;
      status: string;
      score: number;
    }>();
    expect(JSON.parse(row?.payload ?? "{}")).toEqual({ items: ["5.02", "9.01"] });
    expect(row?.status).toBe("new");
    expect(row?.score).toBe(SCORE_POSTABLE);
  });
});

describe("source_state", () => {
  it("returns zero-state for unknown sources", async () => {
    const s = await getSourceState(env.DB, "edgar_8k");
    expect(s).toEqual({
      source: "edgar_8k",
      etag: null,
      lastModified: null,
      cursor: null,
      lastPolledAt: null,
      lastOkAt: null,
      consecutiveFailures: 0,
    });
  });

  it("round-trips and upserts", async () => {
    const s = await getSourceState(env.DB, "house_ptr");
    s.etag = 'W/"abc"';
    s.lastModified = "Fri, 24 Jul 2026 13:00:40 GMT";
    s.cursor = "20035048";
    s.lastPolledAt = "2026-07-26T21:00:00.000Z";
    s.lastOkAt = "2026-07-26T21:00:00.000Z";
    await putSourceState(env.DB, s);

    const back = await getSourceState(env.DB, "house_ptr");
    expect(back.etag).toBe('W/"abc"');
    expect(back.cursor).toBe("20035048");

    back.consecutiveFailures = 3;
    await putSourceState(env.DB, back);
    expect((await getSourceState(env.DB, "house_ptr")).consecutiveFailures).toBe(3);
  });
});

describe("recordSourceError", () => {
  it("persists the failure text so triage is a query, not a timed tail", async () => {
    // Chasing the Treasury 525 took four timed `wrangler tail` attempts,
    // three of which captured nothing: a 30-minute cadence gives a ~2-second
    // window. The error text was the one field not stored.
    await putSourceState(env.DB, {
      source: "err_src",
      etag: null,
      lastModified: null,
      cursor: null,
      lastPolledAt: null,
      lastOkAt: null,
      consecutiveFailures: 1,
    });
    await recordSourceError(env.DB, "err_src", new Error("treasury 525 body=error code: 525"), new Date("2026-07-28T03:00:00Z"));

    const state = await getSourceState(env.DB, "err_src");
    expect(state.lastError).toContain("525");
    expect(state.lastErrorAt).toBe("2026-07-28T03:00:00.000Z");
  });

  it("truncates a long body so an HTML error page cannot fill the row", async () => {
    await putSourceState(env.DB, {
      source: "err_big",
      etag: null,
      lastModified: null,
      cursor: null,
      lastPolledAt: null,
      lastOkAt: null,
      consecutiveFailures: 1,
    });
    await recordSourceError(env.DB, "err_big", "x".repeat(5000));
    const state = await getSourceState(env.DB, "err_big");
    expect((state.lastError ?? "").length).toBeLessThanOrEqual(500);
  });

  it("is a no-op for a source with no state row, never a crash", async () => {
    await expect(recordSourceError(env.DB, "never_seen", new Error("boom"))).resolves.toBeUndefined();
  });
});
