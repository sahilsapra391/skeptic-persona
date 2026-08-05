import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { notifyRetry, MAX_NOTIFY_ATTEMPTS } from "../src/jobs";
import {
  applyEditReply,
  createQueueEntry,
  decideQueueEntry,
  EXPIRY_SWEEP_LIMIT,
  expirePendingBefore,
  getQueueEntry,
  insertItem,
  markEditPrompt,
  SCORE_POSTABLE,
  setQueueTelegramMessageId,
} from "../src/lib/db";

async function seedItem(externalId = "Q-1"): Promise<number> {
  const res = await insertItem(env.DB, {
    source: "edgar_8k",
    externalId,
    category: "filing",
    eventAt: "2026-07-24T21:30:36.000Z",
    sourceUrl: "https://www.sec.gov/x",
    payload: { items: ["4.02"] },
    score: SCORE_POSTABLE,
  });
  return res.id ?? 0;
}

async function itemStatus(id: number): Promise<string> {
  const row = await env.DB.prepare("SELECT status FROM items WHERE id = ?1").bind(id).first<{ status: string }>();
  return row?.status ?? "";
}

const NOW = new Date("2026-07-27T12:00:00Z");

describe("queue state machine", () => {
  it("enqueue marks the item queued and stores the draft", async () => {
    const itemId = await seedItem();
    const qid = await createQueueEntry(env.DB, itemId, "FILING_ALERT", "draft text", NOW);
    expect(qid).toBeGreaterThan(0);
    expect(await itemStatus(itemId)).toBe("queued");

    await setQueueTelegramMessageId(env.DB, qid, 555);
    const entry = await getQueueEntry(env.DB, qid);
    expect(entry).toMatchObject({ state: "pending", telegramMessageId: 555, draftText: "draft text" });
  });

  it("approve wins once; the double-tap loses (idempotent)", async () => {
    const itemId = await seedItem();
    const qid = await createQueueEntry(env.DB, itemId, "WIRE", "d", NOW);

    expect(await decideQueueEntry(env.DB, qid, "approved", NOW)).toBe(true);
    expect(await decideQueueEntry(env.DB, qid, "approved", NOW)).toBe(false);
    expect(await decideQueueEntry(env.DB, qid, "rejected", NOW)).toBe(false);

    expect((await getQueueEntry(env.DB, qid))?.state).toBe("approved");
    expect(await itemStatus(itemId)).toBe("approved");
  });

  it("reject transitions item and queue consistently", async () => {
    const itemId = await seedItem();
    const qid = await createQueueEntry(env.DB, itemId, "WIRE", "d", NOW);
    expect(await decideQueueEntry(env.DB, qid, "rejected", NOW)).toBe(true);
    expect((await getQueueEntry(env.DB, qid))?.state).toBe("rejected");
    expect(await itemStatus(itemId)).toBe("rejected");
  });

  it("edit flow: prompt id is recorded, the reply applies the corrected text exactly once", async () => {
    const itemId = await seedItem();
    const qid = await createQueueEntry(env.DB, itemId, "WIRE", "original", NOW);

    expect(await markEditPrompt(env.DB, qid, 777)).toBe(true);
    const applied = await applyEditReply(env.DB, 777, "corrected text", NOW);
    expect(applied).toBe(qid);

    const entry = await getQueueEntry(env.DB, qid);
    expect(entry).toMatchObject({ state: "edited", editedText: "corrected text", editPromptMessageId: 777 });
    expect(await itemStatus(itemId)).toBe("approved");

    // A second reply to the same prompt is a no-op.
    expect(await applyEditReply(env.DB, 777, "late reply", NOW)).toBeNull();
    expect((await getQueueEntry(env.DB, qid))?.editedText).toBe("corrected text");
  });

  it("edit prompt cannot attach to a decided entry", async () => {
    const itemId = await seedItem();
    const qid = await createQueueEntry(env.DB, itemId, "WIRE", "d", NOW);
    await decideQueueEntry(env.DB, qid, "approved", NOW);
    expect(await markEditPrompt(env.DB, qid, 888)).toBe(false);
  });

  it("expiry sweeps only stale pending entries", async () => {
    const oldItem = await seedItem("Q-old");
    const newItem = await seedItem("Q-new");
    const decidedItem = await seedItem("Q-decided");

    const oldQ = await createQueueEntry(env.DB, oldItem, "WIRE", "d", new Date("2026-07-27T00:00:00Z"));
    await setQueueTelegramMessageId(env.DB, oldQ, 111);
    const newQ = await createQueueEntry(env.DB, newItem, "WIRE", "d", new Date("2026-07-27T11:30:00Z"));
    const decidedQ = await createQueueEntry(env.DB, decidedItem, "WIRE", "d", new Date("2026-07-27T00:00:00Z"));
    await decideQueueEntry(env.DB, decidedQ, "approved", NOW);

    const expired = await expirePendingBefore(env.DB, new Date("2026-07-27T06:00:00Z"), NOW);
    expect(expired).toEqual([{ id: oldQ, telegramMessageId: 111, draftText: "d", editPromptMessageId: null }]);

    expect((await getQueueEntry(env.DB, oldQ))?.state).toBe("expired");
    expect(await itemStatus(oldItem)).toBe("expired");
    expect((await getQueueEntry(env.DB, newQ))?.state).toBe("pending");
    expect((await getQueueEntry(env.DB, decidedQ))?.state).toBe("approved");
  });

  it("expiry sweep is bounded to EXPIRY_SWEEP_LIMIT rows per run", async () => {
    const total = EXPIRY_SWEEP_LIMIT + 3;
    for (let i = 0; i < total; i++) {
      const itemId = await seedItem(`L-${i}`);
      await createQueueEntry(env.DB, itemId, "WIRE", "d", new Date("2026-07-27T00:00:00Z"));
    }
    const cutoff = new Date("2026-07-27T06:00:00Z");
    expect((await expirePendingBefore(env.DB, cutoff, NOW)).length).toBe(EXPIRY_SWEEP_LIMIT);
    expect((await expirePendingBefore(env.DB, cutoff, NOW)).length).toBe(3);
    expect((await expirePendingBefore(env.DB, cutoff, NOW)).length).toBe(0);
  });

  it("expires per archetype when given a cutoff map (p4-00 owner TTLs)", async () => {
    // At sweep time: HALT is 13h old (12h TTL -> expired), CONGRESS_PTR is
    // 50h old (96h TTL -> alive), WIRE is 50h old (48h default -> expired).
    const mk = async (ext: string, archetype: string, ageHours: number) => {
      const itemId = await seedItem(ext);
      return createQueueEntry(env.DB, itemId, archetype, "d", new Date(NOW.getTime() - ageHours * 3_600_000));
    };
    const halt = await mk("T-halt", "HALT", 13);
    const ptr = await mk("T-ptr", "CONGRESS_PTR", 50);
    const wire = await mk("T-wire", "WIRE", 50);

    const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    const expired = await expirePendingBefore(
      env.DB,
      { default: at(48), byArchetype: { HALT: at(12), MACRO_PRINT: at(12), CONGRESS_PTR: at(96) } },
      NOW,
    );

    expect(expired.map((e) => e.id).sort()).toEqual([halt, wire].sort());
    expect((await getQueueEntry(env.DB, ptr))?.state).toBe("pending");
    // The same PTR expires once it outlives ITS OWN window.
    const late = await expirePendingBefore(
      env.DB,
      { default: at(48), byArchetype: { CONGRESS_PTR: at(49) } },
      NOW,
    );
    expect(late.map((e) => e.id)).toEqual([ptr]);
  });

  it("expiry mirror self-heals items stranded 'queued' by a past partial failure", async () => {
    // Simulate historic divergence: queue row expired but item never mirrored.
    const strandedItem = await seedItem("Q-stranded");
    const strandedQ = await createQueueEntry(env.DB, strandedItem, "WIRE", "d", new Date("2026-07-26T00:00:00Z"));
    await env.DB.prepare("UPDATE queue SET state = 'expired' WHERE id = ?1").bind(strandedQ).run();
    expect(await itemStatus(strandedItem)).toBe("queued");

    // Any later sweep repairs it, even when it expires unrelated rows.
    const otherItem = await seedItem("Q-other");
    await createQueueEntry(env.DB, otherItem, "WIRE", "d", new Date("2026-07-27T00:00:00Z"));
    await expirePendingBefore(env.DB, new Date("2026-07-27T06:00:00Z"), NOW);

    expect(await itemStatus(strandedItem)).toBe("expired");
    expect(await itemStatus(otherItem)).toBe("expired");
  });
});

describe("ttlCutoffs env parsing", () => {
  const hoursAgo = (cutoff: Date) => Math.round((NOW.getTime() - cutoff.getTime()) / 3_600_000);

  it("defaults: 48h fallback with the owner's per-archetype map", async () => {
    const { ttlCutoffs } = await import("../src/jobs");
    const cuts = ttlCutoffs({} as never, NOW);
    expect(hoursAgo(cuts.default)).toBe(48);
    expect(hoursAgo(cuts.byArchetype["MACRO_PRINT"]!)).toBe(12);
    expect(hoursAgo(cuts.byArchetype["HALT"]!)).toBe(12);
    expect(hoursAgo(cuts.byArchetype["CONGRESS_PTR"]!)).toBe(96);
  });

  it("env overrides merge key-by-key over the defaults", async () => {
    const { ttlCutoffs } = await import("../src/jobs");
    const cuts = ttlCutoffs(
      { QUEUE_TTL_HOURS: "24", QUEUE_TTL_OVERRIDES: "HALT:6, STORM:120" } as never,
      NOW,
    );
    expect(hoursAgo(cuts.default)).toBe(24);
    expect(hoursAgo(cuts.byArchetype["HALT"]!)).toBe(6); // env wins
    expect(hoursAgo(cuts.byArchetype["STORM"]!)).toBe(120); // env adds
    expect(hoursAgo(cuts.byArchetype["CONGRESS_PTR"]!)).toBe(96); // default survives
  });

  it("a malformed override entry is skipped, never zeroed", async () => {
    const { ttlCutoffs } = await import("../src/jobs");
    const cuts = ttlCutoffs(
      { QUEUE_TTL_OVERRIDES: "HALT:0,CONGRESS_PTR:abc,MACRO_PRINT:-4,,FILING_8K:2" } as never,
      NOW,
    );
    // Invalid values (zero, non-numeric, negative) leave the defaults intact.
    expect(hoursAgo(cuts.byArchetype["HALT"]!)).toBe(12);
    expect(hoursAgo(cuts.byArchetype["CONGRESS_PTR"]!)).toBe(96);
    expect(hoursAgo(cuts.byArchetype["MACRO_PRINT"]!)).toBe(12);
    expect(hoursAgo(cuts.byArchetype["FILING_8K"]!)).toBe(2);
  });
});

describe("notify_retry: an undelivered card is recovered, not lost (2026-08-05)", () => {
  const NOW = new Date("2026-08-05T18:00:00.000Z");
  const SENT: Array<Record<string, unknown>> = [];
  let failNext = false;

  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: /\/botTEST:TOKEN\/sendMessage/, method: "POST" })
      .reply(() => {
        if (failNext) return { statusCode: 500, data: JSON.stringify({ ok: false, error_code: 500, description: "boom" }) };
        SENT.push({});
        return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 7000 + SENT.length } }) };
      })
      .persist();
  });

  async function seedUndelivered(externalId: string, createdAt: string, attempts = 0): Promise<number> {
    const item = await insertItem(env.DB, {
      source: "senate_ptr", externalId, category: "congress", eventAt: createdAt,
      sourceUrl: `https://efdsearch.senate.gov/${externalId}`,
      payload: { member: "Jane Roe" }, score: SCORE_POSTABLE,
    });
    await env.DB.prepare(
      `INSERT INTO queue (item_id, archetype, draft_text, state, created_at, telegram_message_id, notify_attempts)
       VALUES (?1,'CONGRESS_PTR','Draft, per Senate eFD','pending',?2,NULL,?3)`,
    ).bind(item.id, createdAt, attempts).run();
    const q = await env.DB.prepare(`SELECT id FROM queue WHERE item_id = ?1`).bind(item.id).first<{ id: number }>();
    return q!.id;
  }

  it("re-sends a card whose notification never landed, and records the message id", async () => {
    // The exact production state: row created, send failed, nothing retried.
    const qid = await seedUndelivered("nr-recover", "2026-08-05T17:30:00.000Z");
    const before = SENT.length;
    await notifyRetry({ ...env, TELEGRAM_BOT_TOKEN: "TEST:TOKEN", TELEGRAM_CHAT_ID: "424242" } as never, NOW);
    expect(SENT.length).toBe(before + 1);
    const row = await env.DB.prepare(`SELECT telegram_message_id t, notify_attempts a FROM queue WHERE id = ?1`)
      .bind(qid).first<{ t: number | null; a: number }>();
    expect(row!.t).not.toBeNull();
    expect(row!.a).toBe(1);
  });

  it("gives up after MAX_NOTIFY_ATTEMPTS so one poison row cannot starve the rest", async () => {
    const qid = await seedUndelivered("nr-exhausted", "2026-08-05T17:30:00.000Z", MAX_NOTIFY_ATTEMPTS);
    const before = SENT.length;
    await notifyRetry({ ...env, TELEGRAM_BOT_TOKEN: "TEST:TOKEN", TELEGRAM_CHAT_ID: "424242" } as never, NOW);
    expect(SENT.length).toBe(before);
    const row = await env.DB.prepare(`SELECT notify_attempts a FROM queue WHERE id = ?1`).bind(qid).first<{ a: number }>();
    expect(row!.a).toBe(MAX_NOTIFY_ATTEMPTS); // untouched
  });

  it("does NOT resurrect a card that is already past its TTL", async () => {
    // Handing back something the owner can no longer act on is the same
    // mistake queue_expiry exists to prevent.
    await seedUndelivered("nr-stale", "2026-08-01T00:00:00.000Z");
    const before = SENT.length;
    await notifyRetry({ ...env, TELEGRAM_BOT_TOKEN: "TEST:TOKEN", TELEGRAM_CHAT_ID: "424242" } as never, NOW);
    expect(SENT.length).toBe(before);
  });

  it("counts the attempt BEFORE sending, so a throw cannot retry forever", async () => {
    const qid = await seedUndelivered("nr-throws", "2026-08-05T17:30:00.000Z");
    failNext = true;
    try {
      await notifyRetry({ ...env, TELEGRAM_BOT_TOKEN: "TEST:TOKEN", TELEGRAM_CHAT_ID: "424242" } as never, NOW);
    } finally {
      failNext = false;
    }
    const row = await env.DB.prepare(`SELECT telegram_message_id t, notify_attempts a FROM queue WHERE id = ?1`)
      .bind(qid).first<{ t: number | null; a: number }>();
    expect(row!.t).toBeNull();
    expect(row!.a).toBe(1); // the failure was counted, not swallowed
  });
});
