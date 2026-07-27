import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createQueueEntry, getQueueEntry, insertItem, SCORE_POSTABLE, setQueueTelegramMessageId } from "../src/lib/db";

const WEBHOOK_URL = "https://worker.local/tg/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const TG = "https://api.telegram.org";
const BOT = "/botTEST:TOKEN";
const OWNER = 424242;

let updateId = 1000;

// File-level PERSISTENT counters for the three Telegram methods the webhook
// can call, registered once. Undici matches the first registered interceptor,
// so per-test interceptors would be shadowed by any earlier persisted one —
// instead every test asserts DELTAS against these counters. This also gives
// true negative assertions ("no API call happened"), which pending-interceptor
// checks cannot express (unmatched calls are swallowed by the route's catch).
const ACK = { calls: [] as Array<Record<string, unknown>> };
const EDIT = { calls: [] as Array<Record<string, unknown>> };
const SEND = { calls: [] as Array<Record<string, unknown>> };

function snap(): { a: number; e: number; s: number } {
  return { a: ACK.calls.length, e: EDIT.calls.length, s: SEND.calls.length };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get(TG)
    .intercept({ path: `${BOT}/answerCallbackQuery`, method: "POST" })
    .reply(200, (opts) => {
      ACK.calls.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
      return JSON.stringify({ ok: true, result: true });
    })
    .persist();
  fetchMock
    .get(TG)
    .intercept({ path: `${BOT}/editMessageText`, method: "POST" })
    .reply(200, (opts) => {
      EDIT.calls.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
      return JSON.stringify({ ok: true, result: { message_id: 555 } });
    })
    .persist();
  fetchMock
    .get(TG)
    .intercept({ path: `${BOT}/sendMessage`, method: "POST" })
    .reply(200, (opts) => {
      SEND.calls.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
      // Incrementing ids so force-reply prompts are distinguishable.
      return JSON.stringify({ ok: true, result: { message_id: 900 + SEND.calls.length, chat: { id: OWNER } } });
    })
    .persist();
});

function post(body: unknown, secret: string | null = "test-webhook-secret"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers[SECRET_HEADER] = secret;
  return SELF.fetch(WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify(body) });
}

function callbackUpdate(data: string, fromId = OWNER): { update_id: number } & Record<string, unknown> {
  return {
    update_id: ++updateId,
    callback_query: { id: `cbq${updateId}`, from: { id: fromId }, message: { message_id: 555 }, data },
  };
}

function messageUpdate(text: string, opts?: { replyTo?: number; chatId?: number }): unknown {
  return {
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      chat: { id: opts?.chatId ?? OWNER },
      from: { id: opts?.chatId ?? OWNER },
      text,
      ...(opts?.replyTo ? { reply_to_message: { message_id: opts.replyTo } } : {}),
    },
  };
}

async function seedQueued(externalId: string, messageId = 555): Promise<{ itemId: number; queueId: number }> {
  const item = await insertItem(env.DB, {
    source: "edgar_8k",
    externalId,
    category: "filing",
    eventAt: null,
    sourceUrl: "https://www.sec.gov/x",
    payload: {},
    score: SCORE_POSTABLE,
  });
  const queueId = await createQueueEntry(env.DB, item.id ?? 0, "WIRE", "draft body", new Date());
  await setQueueTelegramMessageId(env.DB, queueId, messageId);
  return { itemId: item.id ?? 0, queueId };
}

describe("webhook auth", () => {
  it("rejects a missing or wrong secret header without touching state or the API", async () => {
    const s0 = snap();
    expect((await post(callbackUpdate("a:1"), null)).status).toBe(401);
    expect((await post(callbackUpdate("a:1"), "wrong-secret")).status).toBe(401);
    // Equal length, last byte differs: exercises the timing-safe comparison
    // itself, not just the length-mismatch early return.
    expect((await post(callbackUpdate("a:1"), "test-webhook-secreT")).status).toBe(401);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM processed_updates").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(snap()).toEqual(s0);
  });

  it("rejects malformed bodies", async () => {
    const res = await SELF.fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { [SECRET_HEADER]: "test-webhook-secret", "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("callback actions", () => {
  it("approve: transitions state, answers the callback, badges the draft message", async () => {
    const { queueId } = await seedQueued("W-appr");
    const s0 = snap();

    const res = await post(callbackUpdate(`a:${queueId}`));
    expect(res.status).toBe(200);
    expect((await getQueueEntry(env.DB, queueId))?.state).toBe("approved");
    expect(ACK.calls.length).toBe(s0.a + 1);
    expect(EDIT.calls.length).toBe(s0.e + 1);
    expect(String(EDIT.calls.at(-1)?.text)).toContain("✅ Approved");
    expect(String(EDIT.calls.at(-1)?.text)).toContain("draft body");
  });

  it("double-tap: losing reject cannot override; badge self-heals to the winning state", async () => {
    const { queueId } = await seedQueued("W-dbl");
    const s0 = snap();

    await post(callbackUpdate(`a:${queueId}`));
    await post(callbackUpdate(`r:${queueId}`)); // loses; answers with true state + repairs badge
    expect((await getQueueEntry(env.DB, queueId))?.state).toBe("approved");

    expect(ACK.calls.length).toBe(s0.a + 2);
    expect(String(ACK.calls.at(-1)?.text)).toContain("already approved");
    const edits = EDIT.calls.slice(s0.e);
    expect(edits.length).toBe(2); // decide badge + self-heal repair
    for (const e of edits) expect(String(e.text)).toContain("✅ Approved");
    expect(edits.some((e) => String(e.text).includes("❌"))).toBe(false);
  });

  it("replayed update_id is a no-op: no state change, no repeated API calls", async () => {
    const { queueId } = await seedQueued("W-replay");
    const s0 = snap();

    const update = callbackUpdate(`a:${queueId}`);
    await post(update);
    const replay = await post(update);
    expect(replay.status).toBe(200);
    expect((await getQueueEntry(env.DB, queueId))?.state).toBe("approved");
    expect(ACK.calls.length).toBe(s0.a + 1);
    expect(EDIT.calls.length).toBe(s0.e + 1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM processed_updates WHERE update_id = ?1")
      .bind(update.update_id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("unauthorized tapper is answered but nothing changes", async () => {
    const { queueId } = await seedQueued("W-unauth");
    const s0 = snap();
    await post(callbackUpdate(`a:${queueId}`, 666));
    expect((await getQueueEntry(env.DB, queueId))?.state).toBe("pending");
    expect(ACK.calls.length).toBe(s0.a + 1);
    expect(String(ACK.calls.at(-1)?.text)).toContain("Not authorized");
    expect(EDIT.calls.length).toBe(s0.e);
    expect(SEND.calls.length).toBe(s0.s);
  });

  it("garbage callback data is answered and ignored", async () => {
    const s0 = snap();
    expect((await post(callbackUpdate("z:12"))).status).toBe(200);
    expect((await post(callbackUpdate("a:999999"))).status).toBe(200); // unknown id
    expect(ACK.calls.length).toBe(s0.a + 2);
    expect(EDIT.calls.length).toBe(s0.e);
    expect(SEND.calls.length).toBe(s0.s);
  });
});

describe("edit flow", () => {
  it("edit button sends a force-reply prompt; the reply applies the corrected text", async () => {
    const { queueId } = await seedQueued("W-edit");
    const s0 = snap();

    await post(callbackUpdate(`e:${queueId}`));
    expect(ACK.calls.length).toBe(s0.a + 1);
    expect(SEND.calls.length).toBe(s0.s + 1);
    const promptId = 900 + SEND.calls.length;
    expect((await getQueueEntry(env.DB, queueId))?.editPromptMessageId).toBe(promptId);

    await post(messageUpdate("corrected wire text", { replyTo: promptId }));
    const entry = await getQueueEntry(env.DB, queueId);
    expect(entry?.state).toBe("edited");
    expect(entry?.editedText).toBe("corrected wire text");
    expect(EDIT.calls.length).toBe(s0.e + 1); // draft message rewritten
    expect(String(EDIT.calls.at(-1)?.text)).toContain("✏️ Edited & approved");
    expect(SEND.calls.length).toBe(s0.s + 2); // prompt + confirmation
    expect(String(SEND.calls.at(-1)?.text)).toContain("approved with your edit");
  });

  it("a reply after expiry gets explicit 'NOT applied' feedback", async () => {
    const { queueId } = await seedQueued("W-late");
    await post(callbackUpdate(`e:${queueId}`));
    const promptId = 900 + SEND.calls.length;

    await env.DB.prepare("UPDATE queue SET state = 'expired' WHERE id = ?1").bind(queueId).run();
    const s0 = snap();

    await post(messageUpdate("too-late correction", { replyTo: promptId }));
    expect(SEND.calls.length).toBe(s0.s + 1);
    expect(String(SEND.calls.at(-1)?.text)).toContain("NOT applied");
    expect(EDIT.calls.length).toBe(s0.e);
    const entry = await getQueueEntry(env.DB, queueId);
    expect(entry?.state).toBe("expired");
    expect(entry?.editedText).toBeNull();
  });

  it("a second Edit tap supersedes the first prompt; replies follow the newest", async () => {
    const { queueId } = await seedQueued("W-supersede");
    const s0 = snap();

    await post(callbackUpdate(`e:${queueId}`));
    const firstPrompt = 900 + SEND.calls.length;
    await post(callbackUpdate(`e:${queueId}`));
    const secondPrompt = 900 + SEND.calls.length;
    expect(secondPrompt).toBe(firstPrompt + 1);

    expect((await getQueueEntry(env.DB, queueId))?.editPromptMessageId).toBe(secondPrompt);
    expect(EDIT.calls.length).toBe(s0.e + 1);
    expect(String(EDIT.calls.at(-1)?.text)).toContain("Superseded");

    await post(messageUpdate("v2 text", { replyTo: secondPrompt }));
    const entry = await getQueueEntry(env.DB, queueId);
    expect(entry?.state).toBe("edited");
    expect(entry?.editedText).toBe("v2 text");
    expect(EDIT.calls.length).toBe(s0.e + 2); // supersede note + draft rewrite
  });

  it("replies from a foreign chat are ignored", async () => {
    const { queueId } = await seedQueued("W-foreign");
    await post(callbackUpdate(`e:${queueId}`));
    const promptId = 900 + SEND.calls.length;
    const s0 = snap();

    await post(messageUpdate("evil edit", { replyTo: promptId, chatId: 666 }));
    expect((await getQueueEntry(env.DB, queueId))?.state).toBe("pending");
    expect(snap()).toEqual(s0);
  });

  it("/start gets a hello with the chat id", async () => {
    const s0 = snap();
    expect((await post(messageUpdate("/start"))).status).toBe(200);
    expect(SEND.calls.length).toBe(s0.s + 1);
    expect(String(SEND.calls.at(-1)?.text)).toContain(String(OWNER));
  });

  it("non-reply chatter is ignored silently", async () => {
    const s0 = snap();
    expect((await post(messageUpdate("hello bot"))).status).toBe(200);
    expect(snap()).toEqual(s0);
  });
});

describe("admin smoke test endpoint", () => {
  it("rejects missing or wrong admin key", async () => {
    const s0 = snap();
    const bad = await SELF.fetch("https://worker.local/admin/seed-test", { method: "POST" });
    expect(bad.status).toBe(401);
    const wrong = await SELF.fetch("https://worker.local/admin/seed-test", {
      method: "POST",
      headers: { "X-Admin-Key": "nope" },
    });
    expect(wrong.status).toBe(401);
    expect(snap()).toEqual(s0);
  });

  it("seeds a queued draft and notifies Telegram when authorized", async () => {
    const s0 = snap();
    const res = await SELF.fetch("https://worker.local/admin/seed-test", {
      method: "POST",
      headers: { "X-Admin-Key": "test-webhook-secret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; queueId: number }>();
    expect(body.ok).toBe(true);
    expect(SEND.calls.length).toBe(s0.s + 1);
    expect(String(SEND.calls.at(-1)?.text)).toContain("per Nasdaq");
    const entry = await getQueueEntry(env.DB, body.queueId);
    expect(entry?.state).toBe("pending");
    expect(entry?.telegramMessageId).toBe(900 + SEND.calls.length);
  });
});
