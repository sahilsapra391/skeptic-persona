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

function safeEqual(a: string, b: string): boolean {
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

async function handleCallback(env: ConfiguredEnv, cb: TgCallbackQuery): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (String(cb.from.id) !== env.TELEGRAM_CHAT_ID) {
    log("warn", "callback from unauthorized user", { from: cb.from.id });
    await answerCallbackQuery(token, cb.id, "Not authorized.");
    return;
  }
  // Callback data is client-supplied — validate strictly (verified doc
  // warning: a client can send arbitrary data).
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

  // Edit-flow reply: match against a stored force-reply prompt id.
  if (msg.reply_to_message && msg.text) {
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
