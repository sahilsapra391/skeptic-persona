import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCard, deliverCards } from "../src/rag/deliver";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { iso } from "../src/lib/time";

// The copy-out card + Posted? capture (p2r-05). Card delivery is tested
// directly; the webhook-side flows (copy, posted, regenerate, edit) are
// driven through the real webhook route below.

const NOW = new Date("2026-07-28T16:00:00Z");
const WEBHOOK_URL = "https://worker.local/tg/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const TG = "https://api.telegram.org";
const BOT = "/botTEST:TOKEN";
const OWNER = 424242;

let updateId = 5000;

const ACK = { calls: [] as Array<Record<string, unknown>> };
const SEND = { calls: [] as Array<Record<string, unknown>> };
const EDIT = { calls: [] as Array<Record<string, unknown>> };
const snap = (): { a: number; s: number; e: number } => ({ a: ACK.calls.length, s: SEND.calls.length, e: EDIT.calls.length });

let sendFail = false; // one dynamic interceptor; persisted mocks shadow later ones

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
    .reply((opts) => {
      if (sendFail) return { statusCode: 500, data: JSON.stringify({ ok: false, error_code: 500, description: "boom" }) };
      SEND.calls.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
      return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 900 + SEND.calls.length, chat: { id: OWNER } } }) };
    })
    .persist();
});

async function seedTerminal(
  externalId: string,
  terminal: { variant: "dry" | "sharp" | "commentary" | "none"; text: string; status: string }[],
): Promise<number> {
  const item = await insertItem(env.DB, {
    source: "senate_ptr",
    externalId,
    category: "congress",
    eventAt: iso(NOW),
    sourceUrl: `https://efdsearch.senate.gov/${externalId}`,
    payload: { member: "Jane Roe", lagDays: 45, tradeDate: "2026-06-03", chamber: "senate" },
    score: SCORE_POSTABLE,
  });
  const queueId = await createQueueEntry(env.DB, item.id ?? 0, "CONGRESS_PTR", "Draft text, per Senate eFD", NOW);
  await decideQueueEntry(env.DB, queueId, "approved", NOW);
  for (const t of terminal) {
    await env.DB.prepare(
      `INSERT INTO generations (queue_id, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1, ?2, ?3, 'sk', 'op', ?4, 1, ?5)`,
    )
      .bind(queueId, t.variant, t.text, t.status, iso(NOW))
      .run();
  }
  return queueId;
}

function post(body: unknown): Promise<Response> {
  return SELF.fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", [SECRET_HEADER]: "test-webhook-secret" },
    body: JSON.stringify(body),
  });
}

function tap(data: string): Promise<Response> {
  return post({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from: { id: OWNER }, message: { message_id: 901 }, data } });
}

function reply(toMessageId: number, text: string): Promise<Response> {
  return post({
    update_id: ++updateId,
    message: { message_id: ++updateId, chat: { id: OWNER }, from: { id: OWNER }, text, reply_to_message: { message_id: toMessageId } },
  });
}

describe("buildCard", () => {
  it("valid variants: commentary first, one Copy button each, Edit+Regenerate row", async () => {
    const qid = await seedTerminal("C-valid", [
      { variant: "dry", text: "dry text, per Senate eFD", status: "valid" },
      { variant: "commentary", text: "commentary text long enough to matter, per Senate eFD", status: "valid" },
    ]);
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "valid", "fallback");
    expect(card.text.indexOf("commentary")).toBeLessThan(card.text.indexOf("dry"));
    expect(card.buttons[0]!.map((b) => b.callback_data)).toEqual([`c:c:${qid}`, `c:d:${qid}`]);
    expect(card.buttons[1]!.map((b) => b.callback_data)).toEqual([`ce:${qid}`, `g:${qid}`]);
    expect(card.held).toBe(false);
  });

  it("fallback_template: single Copy draft button carrying the template text", async () => {
    const qid = await seedTerminal("C-fb", [{ variant: "none", text: "the template text, per Senate eFD", status: "fallback_template" }]);
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "fallback_template", "the template text, per Senate eFD");
    expect(card.copyable.template).toBe("the template text, per Senate eFD");
    expect(card.buttons[0]!.map((b) => b.callback_data)).toEqual([`c:t:${qid}`]);
  });

  it("fallback_blocked: HELD, no copy buttons at all", async () => {
    const qid = await seedTerminal("C-held", [{ variant: "none", text: "", status: "fallback_blocked" }]);
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "fallback_blocked", "broken");
    expect(card.held).toBe(true);
    expect(card.text).toContain("HELD");
    expect(JSON.stringify(card.buttons)).not.toContain("c:");
  });
});

describe("deliverCards", () => {
  it("delivers once per row; a cards row is the ledger", async () => {
    const qid = await seedTerminal("D-once", [{ variant: "commentary", text: "text a, per Senate eFD", status: "valid" }]);
    const before = snap();
    await deliverCards(env, NOW);
    expect(SEND.calls.length).toBe(before.s + 1);
    const card = await env.DB.prepare(`SELECT telegram_message_id FROM cards WHERE queue_id = ?1`).bind(qid).first();
    expect(card).not.toBeNull();
    // Second run: nothing to do.
    await deliverCards(env, NOW);
    expect(SEND.calls.length).toBe(before.s + 1);
  });

  it("a failed send leaves NO cards row, so the next tick retries", async () => {
    const qid = await seedTerminal("D-retry", [{ variant: "commentary", text: "text b, per Senate eFD", status: "valid" }]);
    sendFail = true;
    try {
      await deliverCards(env, NOW);
    } finally {
      sendFail = false;
    }
    expect(await env.DB.prepare(`SELECT * FROM cards WHERE queue_id = ?1`).bind(qid).first()).toBeNull();
    await deliverCards(env, NOW);
    expect(await env.DB.prepare(`SELECT * FROM cards WHERE queue_id = ?1`).bind(qid).first()).not.toBeNull();
  });

  it("api_error (non-terminal) rows get NO card yet", async () => {
    await seedTerminal("D-pending", [{ variant: "none", text: "", status: "api_error" }]);
    const before = snap();
    await deliverCards(env, NOW);
    expect(SEND.calls.length).toBe(before.s);
  });
});

describe("card flows through the real webhook", () => {
  async function delivered(externalId: string, text = "the commentary, per Senate eFD"): Promise<number> {
    const qid = await seedTerminal(externalId, [{ variant: "commentary", text, status: "valid" }]);
    await deliverCards(env, NOW);
    return qid;
  }

  it("Copy: mono pre-block with EXACT text, chosen_variant recorded, Posted? follows", async () => {
    const qid = await delivered("W-copy");
    const before = snap();
    await tap(`c:c:${qid}`);
    // Two sends: the mono text, then the Posted? prompt.
    expect(SEND.calls.length).toBe(before.s + 2);
    const mono = SEND.calls[before.s]!;
    expect(mono.text).toBe("the commentary, per Senate eFD");
    expect(JSON.stringify(mono.entities)).toContain('"pre"');
    const posted = SEND.calls[before.s + 1]!;
    expect(JSON.stringify(posted.reply_markup)).toContain(`p:y:${qid}`);
    const card = await env.DB.prepare(`SELECT chosen_variant FROM cards WHERE queue_id = ?1`).bind(qid).first<{ chosen_variant: string }>();
    expect(card!.chosen_variant).toBe("commentary");
  });

  it("Posted=yes: post_log manual row with the copied text, items.status posted, re-tap is a no-op", async () => {
    const qid = await delivered("W-yes");
    await tap(`c:c:${qid}`);
    await tap(`p:y:${qid}`);
    const row = await env.DB.prepare(
      `SELECT posted_manually, final_text, platform_post_id FROM post_log WHERE queue_id = ?1`,
    ).bind(qid).first<{ posted_manually: number; final_text: string; platform_post_id: string | null }>();
    expect(row).toMatchObject({ posted_manually: 1, final_text: "the commentary, per Senate eFD", platform_post_id: null });
    const item = await env.DB.prepare(
      `SELECT i.status FROM items i JOIN queue q ON q.item_id = i.id WHERE q.id = ?1`,
    ).bind(qid).first<{ status: string }>();
    expect(item!.status).toBe("posted");
    // Re-tap: UNIQUE(queue_id) makes it a no-op, acked as already recorded.
    const before = snap();
    await tap(`p:y:${qid}`);
    expect(ACK.calls.length).toBe(before.a + 1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM post_log WHERE queue_id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(1);
  });

  it("Posted=modified: force-reply captures the ACTUAL text verbatim", async () => {
    const qid = await delivered("W-mod");
    await tap(`c:c:${qid}`);
    const before = snap();
    await tap(`p:m:${qid}`);
    expect(SEND.calls.length).toBe(before.s + 1); // the force-reply prompt
    const promptId = 900 + SEND.calls.length;
    const actual = "what I actually posted after tweaking, no register gate applies here";
    await reply(promptId, actual);
    const row = await env.DB.prepare(`SELECT final_text FROM post_log WHERE queue_id = ?1`).bind(qid).first<{ final_text: string }>();
    expect(row!.final_text).toBe(actual);
    const card = await env.DB.prepare(`SELECT posted_state FROM cards WHERE queue_id = ?1`).bind(qid).first<{ posted_state: string }>();
    expect(card!.posted_state).toBe("modified");
  });

  it("Posted=skipped: recorded, no post_log row", async () => {
    const qid = await delivered("W-skip");
    await tap(`c:c:${qid}`);
    await tap(`p:k:${qid}`);
    expect(await env.DB.prepare(`SELECT * FROM post_log WHERE queue_id = ?1`).bind(qid).first()).toBeNull();
    const card = await env.DB.prepare(`SELECT posted_state FROM cards WHERE queue_id = ?1`).bind(qid).first<{ posted_state: string }>();
    expect(card!.posted_state).toBe("skipped");
  });

  it("Regenerate: wipes generations + cards for a fresh cycle, refuses after posted", async () => {
    const qid = await delivered("W-regen");
    await tap(`g:${qid}`);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(0);
    expect(await env.DB.prepare(`SELECT * FROM cards WHERE queue_id = ?1`).bind(qid).first()).toBeNull();

    const qid2 = await delivered("W-regen2");
    await tap(`c:c:${qid2}`);
    await tap(`p:y:${qid2}`);
    await tap(`g:${qid2}`);
    // Posted rows are history; regenerate refuses.
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1`).bind(qid2).first<{ n: number }>())!.n).toBeGreaterThan(0);
  });

  it("card Edit: register-gated reply updates edited_text and restarts the cycle", async () => {
    const qid = await delivered("W-edit");
    const before = snap();
    await tap(`ce:${qid}`);
    const promptId = 900 + SEND.calls.length;
    expect(SEND.calls.length).toBe(before.s + 1);

    // A register-failing edit is refused (hand-typed text gets the gate).
    await reply(promptId, "na");
    expect((await env.DB.prepare(`SELECT edited_text FROM queue WHERE id = ?1`).bind(qid).first<{ edited_text: string | null }>())!.edited_text).toBeNull();

    // A clean edit lands, and the cycle restarts (no generations, no card).
    await tap(`ce:${qid}`);
    const promptId2 = 900 + SEND.calls.length;
    await reply(promptId2, "Corrected text with the lag of 45 days spelled right, per Senate eFD");
    const q = await env.DB.prepare(`SELECT edited_text, state FROM queue WHERE id = ?1`).bind(qid).first<{ edited_text: string; state: string }>();
    expect(q!.edited_text).toContain("Corrected text");
    expect(q!.state).toBe("edited");
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(0);
    expect(await env.DB.prepare(`SELECT * FROM cards WHERE queue_id = ?1`).bind(qid).first()).toBeNull();
  });
});
