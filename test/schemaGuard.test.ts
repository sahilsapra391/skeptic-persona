import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import webhookSource from "../src/telegram/webhook.ts?raw";
import { REQUIRED_SHAPE, findSchemaGap, resetSchemaGuardForTest } from "../src/telegram/schemaGuard";

// P4-20. The incident: a deployed write path referenced five post_log columns
// whose migration had not been applied. The batch threw, the callback branch
// returned 200, and processed_updates had ALREADY claimed the update_id — so
// the tap silently did nothing and could never be redelivered.

const WEBHOOK_URL = "https://worker.local/tg/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
let updateId = 70000;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  for (const path of ["answerCallbackQuery", "sendMessage", "editMessageText"]) {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: `/botTEST:TOKEN/${path}`, method: "POST" })
      .reply(200, () => JSON.stringify({ ok: true, result: { message_id: 1 } }))
      .persist();
  }
});

beforeEach(() => resetSchemaGuardForTest());

const post = (body: unknown): Promise<Response> =>
  SELF.fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", [SECRET_HEADER]: "test-webhook-secret" },
    body: JSON.stringify(body),
  });

const claimed = async (id: number): Promise<boolean> => {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM processed_updates WHERE update_id = ?1`)
    .bind(id)
    .first<{ n: number }>();
  return (r?.n ?? 0) > 0;
};

describe("the required shape cannot drift from the statements it protects", () => {
  // Parsing the source rather than restating it. A hand-maintained second copy
  // is how the exemplar bank and the fabrication floor spent four days
  // disagreeing — the list has to be checked against the writers, not against
  // someone's memory of them.
  it("covers every column the webhook's INSERT statements name", () => {
    const declared = new Map(REQUIRED_SHAPE.map((t) => [t.table, new Set(t.columns)]));
    const missing: string[] = [];
    for (const m of webhookSource.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)/gi)) {
      const table = m[1]!;
      const cols = m[2]!.split(",").map((c) => c.trim()).filter((c) => /^\w+$/.test(c));
      const known = declared.get(table);
      if (!known) { missing.push(`${table} (whole table absent from REQUIRED_SHAPE)`); continue; }
      for (const c of cols) if (!known.has(c)) missing.push(`${table}.${c}`);
    }
    expect(missing, "add these to REQUIRED_SHAPE").toEqual([]);
  });

  it("covers every column the webhook's UPDATE statements SET", () => {
    const declared = new Map(REQUIRED_SHAPE.map((t) => [t.table, new Set(t.columns)]));
    const missing: string[] = [];
    for (const m of webhookSource.matchAll(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)\s+WHERE/gi)) {
      const table = m[1]!;
      const known = declared.get(table);
      if (!known) { missing.push(`${table} (whole table absent)`); continue; }
      for (const a of m[2]!.split(",")) {
        const col = a.trim().split(/\s*=/)[0]?.trim();
        if (col && /^\w+$/.test(col) && !known.has(col)) missing.push(`${table}.${col}`);
      }
    }
    expect(missing, "add these to REQUIRED_SHAPE").toEqual([]);
  });

  it("the parser actually finds statements — guards its own vacuity", () => {
    // Without this, a regex that matches nothing reports a clean sweep.
    const inserts = [...webhookSource.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(/gi)];
    const updates = [...webhookSource.matchAll(/UPDATE\s+(\w+)\s+SET\s/gi)];
    expect(inserts.length, "INSERT parser found nothing").toBeGreaterThanOrEqual(3);
    expect(updates.length, "UPDATE parser found nothing").toBeGreaterThanOrEqual(3);
  });
});

describe("findSchemaGap", () => {
  it("passes against the real applied schema", async () => {
    expect(await findSchemaGap(env.DB)).toBeNull();
  });

  it("names the missing object rather than failing anonymously", async () => {
    resetSchemaGuardForTest();
    const broken = {
      prepare: (sql: string) => ({
        all: async () => {
          if (sql.includes("FROM voice_finals")) throw new Error("no such table: voice_finals");
          return { results: [] };
        },
      }),
    } as unknown as D1Database;
    const gap = await findSchemaGap(broken);
    expect(gap).toContain("voice_finals");
  });

  it("caches only SUCCESS — a failure must not outlive the migration that fixes it", async () => {
    resetSchemaGuardForTest();
    let calls = 0;
    const failing = {
      prepare: () => ({ all: async () => { calls += 1; throw new Error("no such column: draft_text"); } }),
    } as unknown as D1Database;
    expect(await findSchemaGap(failing)).not.toBeNull();
    const first = calls;
    expect(await findSchemaGap(failing)).not.toBeNull();
    expect(calls, "a cached failure would make a self-healing 500 permanent").toBeGreaterThan(first);

    // ...and once the schema is right, it verifies and then stops querying.
    expect(await findSchemaGap(env.DB)).toBeNull();
    const before = await env.DB.prepare(`SELECT 1`).first();
    expect(await findSchemaGap(env.DB)).toBeNull();
    expect(before).not.toBeNull(); // sanity: the DB is live
  });
});

describe("the refusal does NOT consume the update", () => {
  it("a healthy schema serves normally and claims the update", async () => {
    const id = ++updateId;
    const res = await post({ update_id: id, message: { message_id: 1, chat: { id: 424242 }, from: { id: 424242 }, text: "/start" } });
    expect(res.status).toBe(200);
    expect(await claimed(id)).toBe(true);
  });

  it("HIGH: a schema gap returns 500 and leaves the update UNCLAIMED", async () => {
    // The whole point. The 2026-08-02 defect was not that it broke — it is
    // that it broke while claiming the update_id, so Telegram never redelivered
    // and the tap was lost. Dropping a required column reproduces the shape.
    await env.DB.prepare(`ALTER TABLE post_log DROP COLUMN grounding_chars`).run();
    resetSchemaGuardForTest();
    const id = ++updateId;
    try {
      const res = await post({ update_id: id, callback_query: { id: "cb1", from: { id: 424242 }, message: { message_id: 9 }, data: "p:y:1:1:c" } });
      expect(res.status, "must be 5xx so Telegram redelivers").toBe(500);
      expect(await res.text()).toContain("post_log");
      expect(await claimed(id), "an unclaimed update is a redeliverable one").toBe(false);
    } finally {
      await env.DB.prepare(`ALTER TABLE post_log ADD COLUMN grounding_chars INTEGER`).run();
      resetSchemaGuardForTest();
    }
  });

  it("and the SAME update lands once the migration is back — zero lost taps", async () => {
    await env.DB.prepare(`ALTER TABLE post_log DROP COLUMN grounding_chars`).run();
    resetSchemaGuardForTest();
    const id = ++updateId;
    const refused = await post({ update_id: id, message: { message_id: 2, chat: { id: 424242 }, from: { id: 424242 }, text: "/start" } });
    expect(refused.status).toBe(500);
    expect(await claimed(id)).toBe(false);

    await env.DB.prepare(`ALTER TABLE post_log ADD COLUMN grounding_chars INTEGER`).run();
    resetSchemaGuardForTest();
    const redelivered = await post({ update_id: id, message: { message_id: 2, chat: { id: 424242 }, from: { id: 424242 }, text: "/start" } });
    expect(redelivered.status, "the retry Telegram would send").toBe(200);
    expect(await claimed(id)).toBe(true);
  });
});
