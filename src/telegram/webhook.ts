import type { Env } from "../env";
import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
} from "../lib/telegram";
import {
  applyEditReply,
  decideQueueEntry,
  getQueueEntry,
  getQueueEntryByEditPrompt,
  markEditPrompt,
  type QueueEntry,
} from "../lib/db";
import { checkRegister } from "../templates/validate";
import { CODE_VARIANT, postedButtons, type CardVariant } from "../rag/deliver";
import { iso } from "../lib/time";
import { log } from "../lib/log";

export const WEBHOOK_PATH = "/tg/webhook";
export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

// Minimal shapes of the updates we consume (verified field names,
// docs/verification/2026-07-26-telegram-bot-api.md).
interface TgUser {
  id: number;
}
interface TgIncomingMessage {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  reply_to_message?: { message_id: number };
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; date?: number };
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgIncomingMessage;
  callback_query?: TgCallbackQuery;
}

type ConfiguredEnv = Env & {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
};

function telegramConfigured(env: Env): env is ConfiguredEnv {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.TELEGRAM_WEBHOOK_SECRET);
}

export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

function badgeFor(entry: QueueEntry): string | null {
  switch (entry.state) {
    case "approved":
      return `✅ Approved\n\n${entry.draftText}`;
    case "rejected":
      return `❌ Rejected\n\n${entry.draftText}`;
    case "edited":
      return `✏️ Edited & approved\n\n${entry.editedText ?? entry.draftText}`;
    case "expired":
      return `⏰ Expired unapproved\n\n${entry.draftText}`;
    default:
      return null;
  }
}

/**
 * Webhook contract (verified): Telegram POSTs ONE Update per request, retries
 * on any non-2xx "a reasonable amount of attempts", and echoes our secret in
 * the X-Telegram-Bot-Api-Secret-Token header. So: authenticate the header,
 * dedupe on update_id (equality, never monotonicity — ids reset after a week
 * of silence), do the work, and answer 200.
 *
 * Failure policy differs by update type. Callback failures return 200 anyway:
 * the owner sees the spinner and a re-tap mints a fresh update_id. A failed
 * MESSAGE update, though, may carry the owner's typed edit — the one input we
 * cannot regenerate — so those un-mark the dedup row and return 500 to make
 * Telegram redeliver (all message-path D1 transitions are pending-guarded,
 * so replays are safe; post-transition side-effects are caught inside
 * handleMessage and never reach this path).
 */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!telegramConfigured(env)) {
    log("warn", "telegram webhook hit but telegram env not configured");
    return new Response("not configured", { status: 503 });
  }
  const secret = request.headers.get(SECRET_HEADER);
  if (!secret || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    log("warn", "telegram webhook auth failure");
    return new Response("unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = await request.json<TgUpdate>();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (typeof update.update_id !== "number") return new Response("bad request", { status: 400 });

  const seen = await env.DB.prepare(
    `INSERT OR IGNORE INTO processed_updates (update_id, received_at) VALUES (?1, ?2)`,
  )
    .bind(update.update_id, iso(new Date()))
    .run();
  if (seen.meta.changes === 0) return Response.json({}); // Telegram retry replay

  try {
    if (update.callback_query) await handleCallback(env, update.callback_query);
    else if (update.message) await handleMessage(env, update.message);
  } catch (e) {
    log("error", "webhook processing failed", { update_id: update.update_id, error: String(e) });
    if (update.message) {
      try {
        await env.DB.prepare(`DELETE FROM processed_updates WHERE update_id = ?1`).bind(update.update_id).run();
      } catch (delErr) {
        log("warn", "could not unmark update for redelivery", { update_id: update.update_id, error: String(delErr) });
      }
      return new Response("retry", { status: 500 });
    }
  }
  return Response.json({});
}

const CALLBACK_RE = /^([are]):(\d{1,10})$/;
// Card actions (p2r-05): c:<variant>:<qid> copy, p:<y|m|k>:<qid> posted
// capture, g:<qid> regenerate, ce:<qid> card edit. callback_data is capped at
// 64 BYTES by the API, hence single-letter codes.
const CARD_COPY_RE = /^c:([csdt]):(\d{1,10})$/;
const CARD_POSTED_RE = /^p:([ymk]):(\d{1,10})$/;
const CARD_REGEN_RE = /^g:(\d{1,10})$/;
const CARD_EDIT_RE = /^ce:(\d{1,10})$/;

async function handleCallback(env: ConfiguredEnv, cb: TgCallbackQuery): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (String(cb.from.id) !== env.TELEGRAM_CHAT_ID) {
    log("warn", "callback from unauthorized user", { from: cb.from.id });
    await answerCallbackQuery(token, cb.id, "Not authorized.");
    return;
  }
  // Callback data is client-supplied — validate strictly (verified doc
  // warning: a client can send arbitrary data).
  const copy = cb.data ? CARD_COPY_RE.exec(cb.data) : null;
  if (copy) return handleCardCopy(env, cb, CODE_VARIANT[copy[1]!]!, Number(copy[2]));
  const posted = cb.data ? CARD_POSTED_RE.exec(cb.data) : null;
  if (posted) return handleCardPosted(env, cb, posted[1] as "y" | "m" | "k", Number(posted[2]));
  const regen = cb.data ? CARD_REGEN_RE.exec(cb.data) : null;
  if (regen) return handleCardRegenerate(env, cb, Number(regen[1]));
  const cardEdit = cb.data ? CARD_EDIT_RE.exec(cb.data) : null;
  if (cardEdit) return handleCardEdit(env, cb, Number(cardEdit[1]));
  const m = cb.data ? CALLBACK_RE.exec(cb.data) : null;
  if (!m) {
    await answerCallbackQuery(token, cb.id);
    return;
  }
  const action = m[1] as "a" | "r" | "e";
  const queueId = Number(m[2]);
  const entry = await getQueueEntry(env.DB, queueId);
  if (!entry) {
    await answerCallbackQuery(token, cb.id, `Unknown queue entry #${queueId}.`);
    return;
  }

  if (action === "a" || action === "r") {
    const decision = action === "a" ? "approved" : "rejected";
    const won = await decideQueueEntry(env.DB, queueId, decision);
    if (!won) {
      // Lost race / re-tap: report the CURRENT state, and self-heal the draft
      // message badge in case the winning tap's edit never landed.
      const fresh = await getQueueEntry(env.DB, queueId);
      await answerCallbackQuery(token, cb.id, `#${queueId} already ${fresh?.state ?? "handled"}.`);
      const badge = fresh ? badgeFor(fresh) : null;
      if (badge && fresh?.telegramMessageId) {
        try {
          await editMessageText(token, env.TELEGRAM_CHAT_ID, fresh.telegramMessageId, badge);
        } catch (e) {
          log("warn", "badge self-heal failed", { queueId, error: String(e) });
        }
      }
      return;
    }
    await answerCallbackQuery(token, cb.id, `#${queueId} ${decision}.`);
    if (entry.telegramMessageId) {
      const badge = decision === "approved" ? "✅ Approved" : "❌ Rejected";
      await editMessageText(token, env.TELEGRAM_CHAT_ID, entry.telegramMessageId, `${badge}\n\n${entry.draftText}`);
    }
    return;
  }

  // Edit: send a force-reply prompt and remember its message id; the owner's
  // reply to that exact message carries the corrected text.
  if (entry.state !== "pending") {
    await answerCallbackQuery(token, cb.id, `#${queueId} already ${entry.state}.`);
    return;
  }
  await answerCallbackQuery(token, cb.id);
  // A second Edit tap supersedes the previous prompt; mark the old one so a
  // reply to it isn't silently ignored.
  if (entry.editPromptMessageId) {
    try {
      await editMessageText(
        token,
        env.TELEGRAM_CHAT_ID,
        entry.editPromptMessageId,
        `Superseded — use the newest edit prompt for #${queueId}.`,
      );
    } catch (e) {
      log("warn", "could not mark superseded prompt", { queueId, error: String(e) });
    }
  }
  const prompt = await sendMessage(
    token,
    env.TELEGRAM_CHAT_ID,
    `Editing #${queueId}. Reply to THIS message with the corrected post text.`,
    { forceReply: true, replyToMessageId: entry.telegramMessageId ?? undefined },
  );
  const marked = await markEditPrompt(env.DB, queueId, prompt.message_id);
  if (!marked) {
    await editMessageText(token, env.TELEGRAM_CHAT_ID, prompt.message_id, `#${queueId} was already decided; edit cancelled.`);
  }
}

interface CardRow {
  queue_id: number;
  telegram_message_id: number | null;
  chosen_variant: string | null;
  posted_state: string | null;
}

async function getCard(db: D1Database, queueId: number): Promise<CardRow | null> {
  return db
    .prepare(`SELECT queue_id, telegram_message_id, chosen_variant, posted_state FROM cards WHERE queue_id = ?1`)
    .bind(queueId)
    .first<CardRow>();
}

/** The text a variant code stands for, resolved the same way the card built it. */
async function resolveVariantText(db: D1Database, queueId: number, variant: CardVariant): Promise<string | null> {
  if (variant === "template") {
    const q = await db
      .prepare(`SELECT COALESCE(edited_text, draft_text) AS t FROM queue WHERE id = ?1`)
      .bind(queueId)
      .first<{ t: string }>();
    return q?.t ?? null;
  }
  const g = await db
    .prepare(`SELECT text FROM generations WHERE queue_id = ?1 AND variant = ?2 AND status = 'valid' ORDER BY attempt DESC LIMIT 1`)
    .bind(queueId, variant)
    .first<{ text: string }>();
  return g?.text ?? null;
}

async function handleCardCopy(env: ConfiguredEnv, cb: TgCallbackQuery, variant: CardVariant, queueId: number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const card = await getCard(env.DB, queueId);
  if (!card) {
    await answerCallbackQuery(token, cb.id, `No card for #${queueId}.`);
    return;
  }
  const text = await resolveVariantText(env.DB, queueId, variant);
  if (text === null) {
    await answerCallbackQuery(token, cb.id, `No ${variant} text exists for #${queueId}.`);
    return;
  }
  await answerCallbackQuery(token, cb.id, `${variant} ready to copy.`);
  await env.DB.prepare(`UPDATE cards SET chosen_variant = ?1, updated_at = ?2 WHERE queue_id = ?3`)
    .bind(variant, iso(new Date()), queueId)
    .run();
  // The copyable text rides ALONE as a monospace pre block: long-press (or
  // tap on most clients) copies it whole. Then the card asks what happened.
  await sendMessage(token, env.TELEGRAM_CHAT_ID, text, { monospace: true });
  await sendMessage(token, env.TELEGRAM_CHAT_ID, `#${queueId}: paste to X, then answer —`, {
    buttons: postedButtons(queueId),
  });
}

async function handleCardPosted(env: ConfiguredEnv, cb: TgCallbackQuery, action: "y" | "m" | "k", queueId: number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const card = await getCard(env.DB, queueId);
  if (!card) {
    await answerCallbackQuery(token, cb.id, `No card for #${queueId}.`);
    return;
  }
  if (card.posted_state) {
    await answerCallbackQuery(token, cb.id, `#${queueId} already recorded as ${card.posted_state}.`);
    return;
  }

  if (action === "k") {
    await env.DB.prepare(`UPDATE cards SET posted_state = 'skipped', updated_at = ?1 WHERE queue_id = ?2 AND posted_state IS NULL`)
      .bind(iso(new Date()), queueId)
      .run();
    await answerCallbackQuery(token, cb.id, `#${queueId} recorded as skipped.`);
    return;
  }

  if (action === "m") {
    const prompt = await sendMessage(
      token,
      env.TELEGRAM_CHAT_ID,
      `#${queueId}: reply to THIS message with the text EXACTLY as you posted it.`,
      { forceReply: true },
    );
    await env.DB.prepare(`UPDATE cards SET posted_prompt_message_id = ?1, updated_at = ?2 WHERE queue_id = ?3`)
      .bind(prompt.message_id, iso(new Date()), queueId)
      .run();
    await answerCallbackQuery(token, cb.id);
    return;
  }

  // action === "y": what was copied is what was posted.
  const variant = (card.chosen_variant ?? "template") as CardVariant;
  const finalText = await resolveVariantText(env.DB, queueId, variant);
  await recordManualPost(env, queueId, finalText ?? "", cb.id);
}

/** The ledger write both Posted paths share. INSERT OR IGNORE + UNIQUE
 *  (queue_id) makes a re-tap a no-op, same as the poster's pre-claim. */
async function recordManualPost(env: ConfiguredEnv, queueId: number, finalText: string, callbackId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const meta = await env.DB.prepare(
    `SELECT q.item_id, q.archetype, i.category FROM queue q JOIN items i ON i.id = q.item_id WHERE q.id = ?1`,
  )
    .bind(queueId)
    .first<{ item_id: number; archetype: string; category: string }>();
  if (!meta) {
    await answerCallbackQuery(token, callbackId, `Unknown queue entry #${queueId}.`);
    return;
  }
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO post_log (queue_id, platform_post_id, posted_at, archetype, category, posted_manually, final_text)
     VALUES (?1, NULL, ?2, ?3, ?4, 1, ?5)`,
  )
    .bind(queueId, iso(new Date()), meta.archetype, meta.category, finalText)
    .run();
  if (claim.meta.changes === 0) {
    await answerCallbackQuery(token, callbackId, `#${queueId} was already recorded.`);
    return;
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE cards SET posted_state = 'yes', updated_at = ?1 WHERE queue_id = ?2 AND posted_state IS NULL`).bind(iso(new Date()), queueId),
    env.DB.prepare(`UPDATE items SET status = 'posted' WHERE id = ?1`).bind(meta.item_id),
  ]);
  await answerCallbackQuery(token, callbackId, `#${queueId} recorded as posted.`);
  const card = await getCard(env.DB, queueId);
  if (card?.telegram_message_id) {
    try {
      await editMessageText(token, env.TELEGRAM_CHAT_ID, card.telegram_message_id, `📤 Posted to X

${finalText}`);
    } catch (e) {
      log("warn", "posted badge failed", { queueId, error: String(e) });
    }
  }
}

async function handleCardRegenerate(env: ConfiguredEnv, cb: TgCallbackQuery, queueId: number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const card = await getCard(env.DB, queueId);
  if (card?.posted_state === "yes" || card?.posted_state === "modified") {
    await answerCallbackQuery(token, cb.id, `#${queueId} is already posted; not regenerating.`);
    return;
  }
  // Clean slate: the generation lifecycle re-picks the row (no terminal row)
  // and delivery re-fires (no cards row). Attempt numbering restarts, which
  // is correct for an owner-initiated do-over.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM generations WHERE queue_id = ?1`).bind(queueId),
    env.DB.prepare(`DELETE FROM cards WHERE queue_id = ?1`).bind(queueId),
  ]);
  await answerCallbackQuery(token, cb.id, `#${queueId} regenerating; a fresh card lands within ~5 minutes.`);
  if (card?.telegram_message_id) {
    try {
      await editMessageText(token, env.TELEGRAM_CHAT_ID, card.telegram_message_id, `🔁 #${queueId} superseded — regenerating.`);
    } catch (e) {
      log("warn", "regen badge failed", { queueId, error: String(e) });
    }
  }
}

async function handleCardEdit(env: ConfiguredEnv, cb: TgCallbackQuery, queueId: number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const card = await getCard(env.DB, queueId);
  if (!card) {
    await answerCallbackQuery(token, cb.id, `No card for #${queueId}.`);
    return;
  }
  await answerCallbackQuery(token, cb.id);
  const prompt = await sendMessage(
    token,
    env.TELEGRAM_CHAT_ID,
    `Editing #${queueId}. Reply to THIS message with the corrected post text; generation reruns against it.`,
    { forceReply: true },
  );
  await env.DB.prepare(`UPDATE cards SET edit_prompt_message_id = ?1, updated_at = ?2 WHERE queue_id = ?3`)
    .bind(prompt.message_id, iso(new Date()), queueId)
    .run();
}

async function handleMessage(env: ConfiguredEnv, msg: TgIncomingMessage): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (String(msg.chat.id) !== env.TELEGRAM_CHAT_ID) {
    log("warn", "message from unauthorized chat", { chat: msg.chat.id });
    return;
  }

  if (msg.text === "/start") {
    await sendMessage(token, env.TELEGRAM_CHAT_ID, `Skeptic Wire approval bot connected. Chat id: ${msg.chat.id}.`);
    return;
  }

  // Card replies first (p2r-05): posted-modified capture and card edit.
  if (msg.reply_to_message && msg.text) {
    const replyId = msg.reply_to_message.message_id;
    const postedTarget = await env.DB.prepare(`SELECT queue_id FROM cards WHERE posted_prompt_message_id = ?1 AND posted_state IS NULL`)
      .bind(replyId)
      .first<{ queue_id: number }>();
    if (postedTarget) {
      const meta = await env.DB.prepare(
        `SELECT q.item_id, q.archetype, i.category FROM queue q JOIN items i ON i.id = q.item_id WHERE q.id = ?1`,
      ).bind(postedTarget.queue_id).first<{ item_id: number; archetype: string; category: string }>();
      if (meta) {
        // What the owner ACTUALLY posted is ground truth — recorded verbatim,
        // no register gate: it is already public, refusing it here would only
        // blind the ledger to reality.
        const claim = await env.DB.prepare(
          `INSERT OR IGNORE INTO post_log (queue_id, platform_post_id, posted_at, archetype, category, posted_manually, final_text)
           VALUES (?1, NULL, ?2, ?3, ?4, 1, ?5)`,
        ).bind(postedTarget.queue_id, iso(new Date()), meta.archetype, meta.category, msg.text).run();
        if (claim.meta.changes > 0) {
          await env.DB.batch([
            env.DB.prepare(`UPDATE cards SET posted_state = 'modified', updated_at = ?1 WHERE queue_id = ?2 AND posted_state IS NULL`)
              .bind(iso(new Date()), postedTarget.queue_id),
            env.DB.prepare(`UPDATE items SET status = 'posted' WHERE id = ?1`).bind(meta.item_id),
          ]);
        }
        try {
          await sendMessage(token, env.TELEGRAM_CHAT_ID, `#${postedTarget.queue_id} recorded as posted (edited).`, {
            replyToMessageId: msg.message_id,
          });
        } catch (e) {
          log("warn", "posted-modified ack failed", { queueId: postedTarget.queue_id, error: String(e) });
        }
      }
      return;
    }

    const editTarget = await env.DB.prepare(`SELECT queue_id FROM cards WHERE edit_prompt_message_id = ?1`)
      .bind(replyId)
      .first<{ queue_id: number }>();
    if (editTarget) {
      const entry = await getQueueEntry(env.DB, editTarget.queue_id);
      const payload = await env.DB.prepare(`SELECT i.payload FROM items i JOIN queue q ON q.item_id = i.id WHERE q.id = ?1`)
        .bind(editTarget.queue_id)
        .first<{ payload: string }>();
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = payload ? (JSON.parse(payload.payload) as Record<string, unknown>) : undefined;
      } catch {
        parsed = undefined;
      }
      // Card edits feed the NEXT generation run, so they get the register
      // gate like any hand-typed text (doctrine isn't optional here either).
      const issues = checkRegister(msg.text, entry?.archetype as never, parsed as never);
      if (issues.length > 0) {
        await sendMessage(
          token,
          env.TELEGRAM_CHAT_ID,
          `Edit rejected for #${editTarget.queue_id}: ${issues.map((i) => i.detail).join("; ")}. Reply again to retry.`,
          { replyToMessageId: msg.message_id },
        );
        return;
      }
      await env.DB.prepare(`UPDATE queue SET edited_text = ?1, state = 'edited' WHERE id = ?2 AND state IN ('approved','edited')`)
        .bind(msg.text, editTarget.queue_id)
        .run();
      // Clean slate; generation re-runs against the new fallback and a fresh
      // card lands. Same shape as Regenerate.
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM generations WHERE queue_id = ?1`).bind(editTarget.queue_id),
        env.DB.prepare(`DELETE FROM cards WHERE queue_id = ?1`).bind(editTarget.queue_id),
      ]);
      await sendMessage(token, env.TELEGRAM_CHAT_ID, `#${editTarget.queue_id} edit accepted; regenerating against it.`, {
        replyToMessageId: msg.message_id,
      });
      return;
    }
  }

  // Edit-flow reply: match against a stored force-reply prompt id.
  if (msg.reply_to_message && msg.text) {
    // An edited draft bypasses the template engine entirely, so it gets the
    // register rules applied here instead. Rejected outright rather than
    // silently posted: doctrine isn't optional because a human typed it.
    const target = await getQueueEntryByEditPrompt(env.DB, msg.reply_to_message.message_id);
    if (target) {
      const entry = await getQueueEntry(env.DB, target.id);
      // The item's payload decides which citation is correct here. Without it
      // an edited House draft could be re-attributed to the Senate and pass.
      const itemRow = entry
        ? await env.DB.prepare(`SELECT payload FROM items WHERE id = ?1`)
            .bind(entry.itemId)
            .first<{ payload: string }>()
        : null;
      let editPayload: Record<string, unknown> | undefined;
      try {
        editPayload = itemRow ? (JSON.parse(itemRow.payload) as Record<string, unknown>) : undefined;
      } catch {
        editPayload = undefined;
      }
      const issues = checkRegister(msg.text, entry?.archetype as never, editPayload);
      if (issues.length > 0) {
        await sendMessage(
          token,
          env.TELEGRAM_CHAT_ID,
          `Edit rejected for #${target.id}: ${issues.map((i) => i.detail).join("; ")}. The draft is unchanged; reply again to retry.`,
          { replyToMessageId: msg.message_id },
        );
        return;
      }
    }
    const queueId = await applyEditReply(env.DB, msg.reply_to_message.message_id, msg.text);
    if (queueId !== null) {
      // Transition committed. Side-effects below are cosmetic — never let
      // them escape to the 500-redelivery path (a replay would find the
      // entry already 'edited' and report a confusing "not applied").
      try {
        const entry = await getQueueEntry(env.DB, queueId);
        if (entry?.telegramMessageId) {
          await editMessageText(
            token,
            env.TELEGRAM_CHAT_ID,
            entry.telegramMessageId,
            `✏️ Edited & approved\n\n${msg.text}`,
          );
        }
        await sendMessage(token, env.TELEGRAM_CHAT_ID, `#${queueId} approved with your edit.`, {
          replyToMessageId: msg.message_id,
        });
      } catch (e) {
        log("warn", "edit confirmation side-effects failed", { queueId, error: String(e) });
      }
      return;
    }
    // No pending entry matched. If this replied to a real (stale) edit
    // prompt, say so — silence here would read as acceptance.
    const stale = await getQueueEntryByEditPrompt(env.DB, msg.reply_to_message.message_id);
    if (stale) {
      try {
        await sendMessage(
          token,
          env.TELEGRAM_CHAT_ID,
          `#${stale.id} is already ${stale.state}; your edit was NOT applied.`,
          { replyToMessageId: msg.message_id },
        );
      } catch (e) {
        log("warn", "late-edit feedback failed", { queueId: stale.id, error: String(e) });
      }
    }
  }
  // Anything else (small talk, stray messages) is deliberately ignored.
}
