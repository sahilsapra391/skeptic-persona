import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getQueueEntry, insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { enqueueForApproval } from "../src/pipeline/enqueue";
import { registry, tick } from "../src/dispatch";
import { registerJobs } from "../src/jobs";
import { newTickBudget } from "../src/lib/budget";

const HALT_PAYLOAD = {
  symbol: "TSTQ",
  name: "Test Co",
  reasonText: "News Pending",
  reasonCode: "T1",
  haltTimeEtShort: "09:30",
};
import { clampText, TG_TEXT_LIMIT } from "../src/lib/telegram";

const TG = "https://api.telegram.org";
const BOT = "/botTEST:TOKEN";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

async function seedItem(externalId: string): Promise<number> {
  const res = await insertItem(env.DB, {
    source: "edgar_8k",
    externalId,
    category: "filing",
    eventAt: null,
    sourceUrl: "https://www.sec.gov/x",
    payload: {},
    score: SCORE_POSTABLE,
  });
  return res.id ?? 0;
}

describe("enqueueForApproval", () => {
  it("creates the queue row, sends the buttons message, stores its message id", async () => {
    const itemId = await seedItem("E-1");
    let sent: { text?: string; reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } } = {};
    fetchMock
      .get(TG)
      .intercept({ path: `${BOT}/sendMessage`, method: "POST" })
      .reply(200, (opts) => {
        sent = JSON.parse(String(opts.body)) as typeof sent;
        return JSON.stringify({ ok: true, result: { message_id: 321, chat: { id: 424242 } } });
      });

    const { queueId } = await enqueueForApproval(env, itemId, "HALT", HALT_PAYLOAD, "https://www.sec.gov/x");

    const entry = await getQueueEntry(env.DB, queueId);
    expect(entry).toMatchObject({ state: "pending", telegramMessageId: 321 });
    expect(sent.text).toContain("per Nasdaq");
    expect(sent.text).toContain("https://www.sec.gov/x");
    const data = (sent.reply_markup?.inline_keyboard[0] ?? []).map((b) => b.callback_data);
    expect(data).toEqual([`a:${queueId}`, `e:${queueId}`, `r:${queueId}`]);
    for (const d of data) expect(new TextEncoder().encode(d).byteLength).toBeLessThanOrEqual(64);
  });

  it("survives a Telegram failure: queue row stays pending, no message id", async () => {
    const itemId = await seedItem("E-2");
    fetchMock
      .get(TG)
      .intercept({ path: `${BOT}/sendMessage`, method: "POST" })
      .reply(200, JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } }));

    const { queueId } = await enqueueForApproval(env, itemId, "HALT", HALT_PAYLOAD, "https://x.gov");
    const entry = await getQueueEntry(env.DB, queueId);
    expect(entry).toMatchObject({ state: "pending", telegramMessageId: null });
  });
});

describe("clampText", () => {
  it("caps at the verified 4096-char limit", () => {
    const long = "x".repeat(TG_TEXT_LIMIT + 500);
    expect(clampText(long).length).toBe(TG_TEXT_LIMIT);
    expect(clampText("short")).toBe("short");
  });
});

describe("queue_expiry job", () => {
  it("expires stale entries and purges old webhook-dedup rows end-to-end", async () => {
    registerJobs();
    const itemId = await seedItem("E-exp");
    fetchMock
      .get(TG)
      .intercept({ path: `${BOT}/sendMessage`, method: "POST" })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 424242 } } }));
    const { queueId } = await enqueueForApproval(env, itemId, "HALT", HALT_PAYLOAD, "https://x.gov");

    // Expiry sweep edits the stale message.
    fetchMock
      .get(TG)
      .intercept({ path: `${BOT}/editMessageText`, method: "POST" })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: 42 } }));

    // queue_expiry is seeded due in the past by migration 0002; run a tick
    // 12h after enqueue (past the 6h default TTL).
    const later = new Date(Date.now() + 12 * 3_600_000);

    // Dedup purge: 8-day-old row goes, 1-day-old row stays (7-day horizon).
    await env.DB.prepare("INSERT INTO processed_updates (update_id, received_at) VALUES (?1, ?2), (?3, ?4)")
      .bind(1, new Date(later.getTime() - 8 * 86_400_000).toISOString(), 2, new Date(later.getTime() - 86_400_000).toISOString())
      .run();

    // Run the job DIRECTLY rather than through tick(): the source expansion
    // pushed the job count past MAX_JOBS_PER_TICK, so a priority-50 job is no
    // longer guaranteed a slot in any single tick. That is correct scheduling
    // behaviour, but it makes tick() the wrong unit for testing this handler.
    await registry["queue_expiry"]?.(env, later, newTickBudget());

    const entry = await getQueueEntry(env.DB, queueId);
    expect(entry?.state).toBe("expired");
    const remaining = await env.DB.prepare("SELECT update_id FROM processed_updates ORDER BY update_id").all<{
      update_id: number;
    }>();
    expect(remaining.results.map((r) => r.update_id)).toEqual([2]);
    delete registry["queue_expiry"];
  });

  it("garbage QUEUE_TTL_HOURS falls back to the default instead of insta-expiring", async () => {
    registerJobs();
    const itemId = await seedItem("E-ttl");
    fetchMock
      .get(TG)
      .intercept({ path: `${BOT}/sendMessage`, method: "POST" })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: 43, chat: { id: 424242 } } }));
    const { queueId } = await enqueueForApproval(env, itemId, "HALT", HALT_PAYLOAD, "https://x.gov");

    // "-1" would make the cutoff land in the future and expire everything.
    const hostile = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { QUEUE_TTL_HOURS: "-1" });
    await registry["queue_expiry"]?.(hostile, new Date(), newTickBudget());

    expect((await getQueueEntry(env.DB, queueId))?.state).toBe("pending");
    delete registry["queue_expiry"];
  });
});

describe("the payload in D1 is the payload that was rendered", () => {
  it("writes enrichment back so a re-render reproduces the same text", async () => {
    // THE SEAM: edgar8k adds lookback fields (priorSameItemThisYear,
    // sameItemOccurrence, lookbackCoverageDays) to the IN-MEMORY payload on
    // the way to enqueue. They were never persisted, so items.payload did not
    // match what produced the draft: a re-render from D1 saw no lookback
    // fields, could pick a different beat, and would differ from what the
    // owner approved. It also made every lookback-gated beat invisible to
    // anything reading the payload afterwards.
    const seeded = await insertItem(
      env.DB,
      {
        source: "edgar_8k",
        externalId: "writeback-1",
        category: "filing",
        eventAt: null,
        sourceUrl: "https://example.test/8k",
        payload: { company: "ACME CORP", formType: "8-K", itemCodes: ["4.02"] },
        score: SCORE_POSTABLE,
        status: "new",
      },
      new Date(),
    );
    expect(seeded.outcome).toBe("inserted");
    const itemId = seeded.id!;

    const enriched = {
      company: "ACME CORP",
      formType: "8-K",
      items: [{ code: "4.02", title: "Non-Reliance on Previously Issued Financial Statements" }],
      itemCodes: ["4.02"],
      priorSameItemThisYear: 1,
      sameItemOccurrence: 2,
      lookbackCoverageDays: 120,
    };
    await enqueueForApproval(env as never, itemId, "FILING_8K", enriched, "https://example.test/8k", new Date());

    const row = await env.DB.prepare(`SELECT payload FROM items WHERE id = ?1`)
      .bind(itemId)
      .first<{ payload: string }>();
    const stored = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(stored.sameItemOccurrence).toBe(2);
    expect(stored.priorSameItemThisYear).toBe(1);
    expect(stored.lookbackCoverageDays).toBe(120);
  });
});
