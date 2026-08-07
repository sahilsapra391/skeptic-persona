import { renderGenHealth } from "../src/rag/digest";
import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCard, deliverCards, resolveVariantText } from "../src/rag/deliver";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { COPY_TEXT_LIMIT } from "../src/lib/telegram";
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

async function cycleOf(queueId: number): Promise<number> {
  const r = await env.DB.prepare(`SELECT MAX(id) AS c FROM generations WHERE queue_id = ?1`).bind(queueId).first<{ c: number }>();
  return r!.c;
}

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
    const cy = await cycleOf(qid);
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "valid", cy);
    expect(card.text.indexOf("commentary")).toBeLessThan(card.text.indexOf("dry"));
    expect(card.buttons[0]!.map((b) => b.callback_data)).toEqual([`c:c:${qid}:${cy}`, `c:d:${qid}:${cy}`]);
    expect(card.buttons[1]!.map((b) => b.callback_data)).toEqual([`ce:${qid}:${cy}`, `g:${qid}:${cy}`]);
    expect(card.held).toBe(false);
  });

  it("fallback_template: card shows the RE-RENDERED text from generations, not the stale queue draft", async () => {
    // Review findings #4/#7/#8: the fallback_template row may carry a text
    // generation re-rendered under the current budget; queue.draft_text may
    // be the over-budget original. Card AND copy must both use the former.
    const qid = await seedTerminal("C-fb", [{ variant: "none", text: "the RE-RENDERED text, per Senate eFD", status: "fallback_template" }]);
    const cy = await cycleOf(qid);
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "fallback_template", cy);
    expect(card.text).toContain("the RE-RENDERED text, per Senate eFD");
    expect(card.text).not.toContain("Draft text, per Senate eFD");
    expect(await resolveVariantText(env.DB, qid, "template")).toBe("the RE-RENDERED text, per Senate eFD");
    // B-07.3 / B-08.6: a fallback card carries NO Copy button. Its text never
    // passed the voice gates, and copying it publishes machine text under the
    // desk's name. Only the two routes to HAVING a voice remain.
    const cbs = card.buttons.flat().map((b) => b.callback_data);
    expect(cbs).not.toContain(`c:t:${qid}:${cy}`);
    expect(cbs.some((c) => String(c).startsWith("c:"))).toBe(false);
    expect(cbs).toEqual([`ce:${qid}:${cy}`, `g:${qid}:${cy}`]);
    // And it says so, in the card, where the decision is made.
    expect(card.text).toContain("NOT copy-ready");
    expect(card.text).toMatch(/Regenerate to try again, or Edit to write it yourself\./);
  });

  it("fallback_blocked: HELD, no copy buttons at all", async () => {
    const qid = await seedTerminal("C-held", [{ variant: "none", text: "", status: "fallback_blocked" }]);
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "fallback_blocked", await cycleOf(qid));
    expect(card.held).toBe(true);
    expect(card.text).toContain("HELD");
    expect(JSON.stringify(card.buttons)).not.toContain('"c:');
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

  it("the no-exemplar label NAMES the archetype", async () => {
    const qid = await seedTerminal("D-label", [{ variant: "none", text: "", status: "skipped_no_exemplar" }]);
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "skipped_no_exemplar", await cycleOf(qid));
    expect(card.text).toContain("No exemplar for CONGRESS_PTR");
    // Same rule: nothing copy-ready, and no Copy button to suggest otherwise.
    const cbs = card.buttons.flat().map((b) => b.callback_data);
    expect(cbs.some((c) => String(c).startsWith("c:"))).toBe(false);
    expect(card.text).toContain("NOT copy-ready");
  });

  it("a tap on a CLOSED card (no cards row) says closed, not 'use the newest card'", async () => {
    const qid = await seedTerminal("D-closed", [{ variant: "commentary", text: "gone, per Senate eFD", status: "valid" }]);
    await deliverCards(env, NOW);
    const cy = await cycleOf(qid);
    await env.DB.prepare(`DELETE FROM cards WHERE queue_id = ?1`).bind(qid).run(); // the flush shape
    await tap(`c:c:${qid}:${cy}`);
    // Main's wording: a flushed card must NOT point at a "newest card" that
    // does not exist. Asserting the DISTINCTION, not the exact phrasing.
    expect(String(ACK.calls.at(-1)!.text)).toMatch(/flushed|closed|expired/i);
    expect(String(ACK.calls.at(-1)!.text)).not.toContain("newest card");
  });

  it("rejected:payload rows get a HELD card instead of stranding silently", async () => {
    const qid = await seedTerminal("D-badpayload", [{ variant: "none", text: "", status: "rejected:payload" }]);
    const before = snap();
    await deliverCards(env, NOW);
    expect(SEND.calls.length).toBe(before.s + 1);
    expect(String(SEND.calls.at(-1)!.text)).toContain("does not parse");
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
  async function delivered(externalId: string, text = "the commentary, per Senate eFD"): Promise<{ qid: number; cy: number }> {
    const qid = await seedTerminal(externalId, [{ variant: "commentary", text, status: "valid" }]);
    await deliverCards(env, NOW);
    return { qid, cy: await cycleOf(qid) };
  }

  it("Copy: mono pre-block with EXACT text, Posted? keyboard carries cycle AND variant", async () => {
    const { qid, cy } = await delivered("W-copy");
    const before = snap();
    await tap(`c:c:${qid}:${cy}`);
    expect(SEND.calls.length).toBe(before.s + 2);
    const mono = SEND.calls[before.s]!;
    expect(mono.text).toBe("the commentary, per Senate eFD");
    expect(JSON.stringify(mono.entities)).toContain('"pre"');
    const posted = SEND.calls[before.s + 1]!;
    expect(JSON.stringify(posted.reply_markup)).toContain(`p:y:${qid}:${cy}:c`);
  });

  it("B-08.6: a TEMPLATE Copy tap is refused, and sends no text at all", async () => {
    // buildCard no longer draws this button, but cards already sitting in the
    // chat still carry theirs, and a button that exists gets tapped. Removing
    // the button only protects NEW cards; refusing the tap is what enforces
    // the rule. Copying machine text that never passed the voice gates, under
    // the desk's name, is the failure the voice system exists to prevent.
    const { qid, cy } = await delivered("W-tmpl-copy");
    const before = snap();
    await tap(`c:t:${qid}:${cy}`);
    // Nothing is sent: no mono block, no Posted? keyboard, no copy button.
    expect(SEND.calls.length).toBe(before.s);
    // And the refusal is a modal, not a toast a tap can miss.
    const ans = ACK.calls[ACK.calls.length - 1]!;
    expect(String(ans.text)).toContain("Regenerate");
    expect(ans.show_alert).toBe(true);
  });

  it("STALE-CYCLE tap does nothing (the review's fabricated-post CRITICAL)", async () => {
    const { qid, cy } = await delivered("W-stale");
    // Regenerate opens cycle 1; re-seed + redeliver mints a HIGHER card cycle.
    // The new draft is stamped cycle 1 with attempt 2, mirroring the generator:
    // attempt numbering is global per row, so it cannot reuse 1. Under the old
    // wiping behaviour this insert reused attempt 1 and only worked because the
    // prior row had been deleted.
    await tap(`g:${qid}:${cy}`);
    await env.DB.prepare(
      `INSERT INTO generations (queue_id, cycle, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1,1,'commentary','fresh text, per Senate eFD','sk','op','valid',2,?2)`,
    ).bind(qid, iso(NOW)).run();
    await deliverCards(env, NOW);
    const newCy = await cycleOf(qid);
    expect(newCy).toBeGreaterThan(cy);
    // A tap from the OLD cycle: acked as stale, no state change, no post_log.
    const before = snap();
    await tap(`p:y:${qid}:${cy}:c`);
    expect(String(ACK.calls.at(-1)!.text)).toContain("Stale");
    expect(SEND.calls.length).toBe(before.s);
    expect(await env.DB.prepare(`SELECT * FROM post_log WHERE queue_id = ?1`).bind(qid).first()).toBeNull();
  });

  it("Posted=yes: post_log manual row with the TAPPED PROMPT's text, items posted, re-tap no-op", async () => {
    const { qid, cy } = await delivered("W-yes");
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:y:${qid}:${cy}:c`);
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
    await tap(`p:y:${qid}:${cy}:c`);
    expect(ACK.calls.length).toBe(before.a + 1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM post_log WHERE queue_id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(1);
  });

  it("Posted=modified: force-reply captures the ACTUAL text verbatim", async () => {
    const { qid, cy } = await delivered("W-mod");
    await tap(`c:c:${qid}:${cy}`);
    const before = snap();
    await tap(`p:m:${qid}:${cy}:c`);
    expect(SEND.calls.length).toBe(before.s + 1); // the force-reply prompt
    const promptId = 900 + SEND.calls.length;
    const actual = "what I actually posted after tweaking, no register gate applies here";
    await reply(promptId, actual);
    const row = await env.DB.prepare(`SELECT final_text FROM post_log WHERE queue_id = ?1`).bind(qid).first<{ final_text: string }>();
    expect(row!.final_text).toBe(actual);
    const card = await env.DB.prepare(`SELECT posted_state FROM cards WHERE queue_id = ?1`).bind(qid).first<{ posted_state: string }>();
    expect(card!.posted_state).toBe("modified");
  });

  it("Posted=skipped: recorded, no post_log row — and skip-then-yes still records honestly", async () => {
    const { qid, cy } = await delivered("W-skip");
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:k:${qid}:${cy}:c`);
    expect(await env.DB.prepare(`SELECT * FROM post_log WHERE queue_id = ?1`).bind(qid).first()).toBeNull();
    const card = await env.DB.prepare(`SELECT posted_state FROM cards WHERE queue_id = ?1`).bind(qid).first<{ posted_state: string }>();
    expect(card!.posted_state).toBe("skipped");
    // The owner changes their mind and posts after all: allowed, recorded.
    await tap(`p:y:${qid}:${cy}:c`);
    expect(await env.DB.prepare(`SELECT posted_manually FROM post_log WHERE queue_id = ?1`).bind(qid).first()).toMatchObject({ posted_manually: 1 });
    expect((await env.DB.prepare(`SELECT posted_state FROM cards WHERE queue_id = ?1`).bind(qid).first<{ posted_state: string }>())!.posted_state).toBe("yes");
  });

  it("REGENERATE refuses while a Posted-edited capture is pending (the review's vanishing-reply CRITICAL)", async () => {
    const { qid, cy } = await delivered("W-pending");
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:m:${qid}:${cy}:c`); // capture now in flight
    await tap(`g:${qid}:${cy}`);
    expect(String(ACK.calls.at(-1)!.text)).toContain("pending");
    // Nothing was wiped: the capture can still complete.
    expect(await env.DB.prepare(`SELECT * FROM cards WHERE queue_id = ?1`).bind(qid).first()).not.toBeNull();
    const promptId = 900 + SEND.calls.length;
    await reply(promptId, "the text as actually posted");
    expect((await env.DB.prepare(`SELECT final_text FROM post_log WHERE queue_id = ?1`).bind(qid).first<{ final_text: string }>())!.final_text).toBe("the text as actually posted");
  });

  it("Regenerate: APPEND-ONLY new cycle, history kept; refuses after posted; EDIT refuses after posted too", async () => {
    const { qid, cy } = await delivered("W-regen");
    await tap(`g:${qid}:${cy}`);
    // p5-01: the prior draft SURVIVES. This assertion is inverted from what it
    // was; a regression here means drafts are being destroyed again.
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare(`SELECT regen_cycle AS n FROM queue WHERE id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(1);
    // The surviving row belongs to the OLD cycle, so it cannot hold the row
    // shut: nothing is terminal at cycle 1 and the generator re-picks it.
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1 AND cycle = 1`).bind(qid).first<{ n: number }>())!.n,
    ).toBe(0);
    // The cards row is DELIVERY state, not history: it still goes, so the old
    // message's buttons are stale during the regeneration window.
    expect(await env.DB.prepare(`SELECT * FROM cards WHERE queue_id = ?1`).bind(qid).first()).toBeNull();

    const { qid: qid2, cy: cy2 } = await delivered("W-regen2");
    await tap(`c:c:${qid2}:${cy2}`);
    await tap(`p:y:${qid2}:${cy2}:c`);
    await tap(`g:${qid2}:${cy2}`);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1`).bind(qid2).first<{ n: number }>())!.n).toBeGreaterThan(0);
    // Edit gets the same history rule (review finding: it lacked the guard).
    const before = snap();
    await tap(`ce:${qid2}:${cy2}`);
    expect(String(ACK.calls.at(-1)!.text)).toContain("already posted");
    expect(SEND.calls.length).toBe(before.s); // no edit prompt was sent
  });

  it("card Edit: register-gated reply updates edited_text and restarts the cycle", async () => {
    const { qid, cy } = await delivered("W-edit");
    const before = snap();
    await tap(`ce:${qid}:${cy}`);
    const promptId = 900 + SEND.calls.length;
    expect(SEND.calls.length).toBe(before.s + 1);

    // A register-failing edit is refused (hand-typed text gets the gate).
    await reply(promptId, "na");
    expect((await env.DB.prepare(`SELECT edited_text FROM queue WHERE id = ?1`).bind(qid).first<{ edited_text: string | null }>())!.edited_text).toBeNull();

    // A clean edit lands, and the cycle restarts (no generations, no card).
    await tap(`ce:${qid}:${cy}`);
    const promptId2 = 900 + SEND.calls.length;
    await reply(promptId2, "Corrected text with the lag of 45 days spelled right, per Senate eFD");
    const q = await env.DB.prepare(`SELECT edited_text, state FROM queue WHERE id = ?1`).bind(qid).first<{ edited_text: string; state: string }>();
    expect(q!.edited_text).toContain("Corrected text");
    expect(q!.state).toBe("edited");
    // Hand-written text has no skeleton (same rule as applyEditReply).
    const rot = await env.DB.prepare(`SELECT skeleton_id, beat_id FROM queue WHERE id = ?1`).bind(qid).first<{ skeleton_id: string | null; beat_id: string | null }>();
    expect(rot).toEqual({ skeleton_id: null, beat_id: null });
    // p5-01: an edit opens a new cycle, it does not erase what the row said
    // before. The pre-edit draft is still there and still readable.
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare(`SELECT regen_cycle AS n FROM queue WHERE id = ?1`).bind(qid).first<{ n: number }>())!.n).toBe(1);
    expect(await env.DB.prepare(`SELECT * FROM cards WHERE queue_id = ?1`).bind(qid).first()).toBeNull();
  });
});

describe("p5-01: cycles are not blended, and history is retrievable", () => {
  async function seedTwoCycles(externalId: string): Promise<number> {
    const item = await insertItem(env.DB, {
      source: "senate_ptr",
      externalId,
      category: "congress",
      eventAt: iso(NOW),
      sourceUrl: `https://efdsearch.senate.gov/${externalId}`,
      payload: { member: "Jane Roe", lagDays: 45, tradeDate: "2026-06-03", chamber: "senate" },
      score: SCORE_POSTABLE,
    });
    const qid = await createQueueEntry(env.DB, item.id ?? 0, "CONGRESS_PTR", "Draft text, per Senate eFD", NOW);
    await decideQueueEntry(env.DB, qid, "approved", NOW);
    await env.DB.batch([
      // Cycle 0: the pass the owner threw away. It had a commentary.
      env.DB.prepare(
        `INSERT INTO generations (queue_id, cycle, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
         VALUES (?1,0,'commentary','DISCARDED commentary, per Senate eFD','sk0','op0','valid',1,?2)`,
      ).bind(qid, iso(NOW)),
      // Cycle 1: the live pass produced only a dry.
      env.DB.prepare(
        `INSERT INTO generations (queue_id, cycle, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
         VALUES (?1,1,'dry','LIVE dry, per Senate eFD','sk1','op1','valid',2,?2)`,
      ).bind(qid, iso(NOW)),
      env.DB.prepare(`UPDATE queue SET regen_cycle = 1 WHERE id = ?1`).bind(qid),
    ]);
    return qid;
  }

  it("the card shows ONE cycle, never a mix of the live pass and a discarded one", async () => {
    const qid = await seedTwoCycles("W-noblend");
    const card = await buildCard(env.DB, qid, "CONGRESS_PTR", "valid", 99);
    expect(card.text).toContain("LIVE dry");
    // The discarded commentary must not be paired with the live dry and
    // presented as one draft set. Commentary is the deliverable, so a blend
    // here is the version most likely to actually get posted.
    expect(card.text).not.toContain("DISCARDED");
    expect(JSON.stringify(card.buttons)).not.toContain("Copy commentary");
    // Copy resolves against the live cycle too, not just the card render.
    expect(await resolveVariantText(env.DB, qid, "commentary")).toBeNull();
    expect(await resolveVariantText(env.DB, qid, "dry")).toBe("LIVE dry, per Senate eFD");
  });

  it("GET /admin/generations returns every cycle, flags the current one, and is auth-gated", async () => {
    const qid = await seedTwoCycles("W-history");
    const url = `https://worker.local/admin/generations?queue_id=${qid}`;

    expect((await SELF.fetch(url)).status).toBe(401);
    expect((await SELF.fetch(url, { headers: { "X-Admin-Key": "wrong" } })).status).toBe(401);

    const res = await SELF.fetch(url, { headers: { "X-Admin-Key": "test-webhook-secret" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current_cycle: number;
      returned_rows: number;
      truncated: boolean;
      cycles: Array<{ cycle: number; current: boolean; drafts: Array<{ text: string }> }>;
    };
    expect(body.current_cycle).toBe(1);
    expect(body.returned_rows).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.cycles.map((c) => c.cycle)).toEqual([0, 1]);
    expect(body.cycles.find((c) => c.cycle === 0)!.current).toBe(false);
    expect(body.cycles.find((c) => c.cycle === 1)!.current).toBe(true);
    // The whole point: the discarded draft is still readable after the regen.
    expect(body.cycles.find((c) => c.cycle === 0)!.drafts[0]!.text).toContain("DISCARDED commentary");

    expect((await SELF.fetch(`https://worker.local/admin/generations?queue_id=999999`, {
      headers: { "X-Admin-Key": "test-webhook-secret" },
    })).status).toBe(404);
    expect((await SELF.fetch(`https://worker.local/admin/generations?queue_id=abc`, {
      headers: { "X-Admin-Key": "test-webhook-secret" },
    })).status).toBe(400);
  });
});

describe("the Copy button actually copies (Bot API 7.11 CopyTextButton)", () => {
  it("attaches a native copy_text button when the draft fits the 256-char cap", async () => {
    // A bot CANNOT write to the clipboard from a callback, so the old flow only
    // ever PRESENTED text to long-press. The owner reported it as "Copy does
    // not copy", and he was right. CopyTextButton is the real thing.
    const short = "SEC charges Alpha LLC, per SEC";
    const qid = await seedTerminal("CB-fits", [{ variant: "commentary", text: short, status: "valid" }]);
    await deliverCards(env, NOW);
    const cy = await cycleOf(qid);
    const before = snap();
    await tap(`c:c:${qid}:${cy}`);

    const sent = SEND.calls.slice(before.s);
    // The monospace block still rides: it is the fallback and works at any
    // length, on any client version.
    expect(sent[0]!.text).toBe(short);
    expect(JSON.stringify(sent[0]!.entities)).toContain('"pre"');
    // ...and now a real copy button carrying the EXACT text.
    const markup = JSON.stringify(sent[1]!.reply_markup);
    expect(markup).toContain("copy_text");
    expect(JSON.parse(markup).inline_keyboard[0][0].copy_text.text).toBe(short);
    expect(String(sent[1]!.text)).toContain("tap Copy");
  });

  it("falls back to long-press when the draft EXCEEDS the cap, rather than 400ing", async () => {
    // The cap is 256 and a post may be 280, so this boundary is real rather
    // than theoretical. Sending an over-long copy_text is a 400 from Telegram,
    // which would take the whole message down and leave the owner with nothing
    // — strictly worse than the long-press block he already had.
    const long = `${"x".repeat(COPY_TEXT_LIMIT + 1)}`;
    const qid = await seedTerminal("CB-toolong", [{ variant: "commentary", text: long, status: "valid" }]);
    await deliverCards(env, NOW);
    const cy = await cycleOf(qid);
    const before = snap();
    await tap(`c:c:${qid}:${cy}`);

    const sent = SEND.calls.slice(before.s);
    expect(sent[0]!.text).toBe(long); // the block still carries the full text
    const markup = JSON.stringify(sent[1]!.reply_markup);
    expect(markup).not.toContain("copy_text");
    // And it SAYS why, with the number, instead of silently offering less.
    expect(String(sent[1]!.text)).toContain(`${long.length} chars`);
    expect(String(sent[1]!.text)).toContain("long-press");
  });

  it("the Posted? keyboard still rides alongside the copy button", async () => {
    // The copy button must not displace the capture flow: an added button that
    // costs the post_log row would trade one silent gap for another.
    const qid = await seedTerminal("CB-posted", [{ variant: "commentary", text: "short text, per SEC", status: "valid" }]);
    await deliverCards(env, NOW);
    const cy = await cycleOf(qid);
    const before = snap();
    await tap(`c:c:${qid}:${cy}`);
    const markup = JSON.stringify(SEND.calls[before.s + 1]!.reply_markup);
    expect(markup).toContain(`p:y:${qid}:${cy}:c`);
    expect(markup).toContain(`p:m:${qid}:${cy}:c`);
    expect(markup).toContain(`p:k:${qid}:${cy}:c`);
  });
});

describe("B-08.6: generation health in the digest", () => {
  it("counts api failures SEPARATELY from rejections", async () => {
    const rows = [
      { archetype: "A", cards: 10, fell_back: 1, api_cards: 0, top_reason: "number", top_reason_n: 3 },
      { archetype: "B", cards: 2, fell_back: 2, api_cards: 2, top_reason: null, top_reason_n: 0 },
    ];
    const out = renderGenHealth(rows).join("\n");
    // 3 of 12 = 25%.
    expect(out).toContain("25% fallback (3 of 12 cards)");
    expect(out).toContain("Target under 10%. Baseline 36%.");
    expect(out).toContain("A: 1/10 fell back, top reason number x3");
    // B never reached a gate, so it gets no invented reason.
    expect(out).toContain("B: 2/2 fell back, 2 hit the API");
    expect(out).not.toContain("B: 2/2 fell back, top reason");
  });

  it("says nothing when there is nothing to say", () => {
    expect(renderGenHealth([])).toEqual([]);
    expect(renderGenHealth([{ archetype: "A", cards: 5, fell_back: 0, api_cards: 0, top_reason: null, top_reason_n: 0 }]).join("\n"))
      .toContain("0% fallback");
  });
});
