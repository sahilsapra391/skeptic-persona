// Minimal Telegram Bot API client (verified 2026-07-26, docs/verification/).
// Design decisions from verification:
// - NO parse_mode: drafts are full of $ % . - ( ), which MarkdownV2 rejects
//   outright (400 can't-parse-entities). Plain text renders everything.
// - text hard limit 4096 chars (after entity parsing) -> clamp client-side.
// - Link previews disabled via link_preview_options (disable_web_page_preview
//   no longer exists in the current API).
// - Error envelope: {ok, result | error_code, description, parameters}.
//   Telegram's HTTP status class is trustworthy (verified: bad token = clean
//   401), but we still parse the envelope.

export const TG_TEXT_LIMIT = 4096;

export interface TgInlineButton {
  text: string;
  callback_data: string; // 1-64 BYTES per the API
}

export interface TgMessageResult {
  message_id: number;
  chat: { id: number };
}

export class TelegramError extends Error {
  constructor(
    readonly errorCode: number,
    description: string,
    readonly retryAfter: number | null,
  ) {
    super(`telegram ${errorCode}: ${description}`);
  }
}

export function clampText(text: string, limit: number = TG_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  let cut = limit - 1;
  // slice(0, cut) ends at text[cut - 1]; if that unit is a high surrogate,
  // its low half would be severed — back off one unit so we never emit a
  // lone surrogate (JSON.stringify would send an unpaired \ud escape).
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

async function tgCall<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  // A gateway error page during a Telegram outage is HTML, not the JSON
  // envelope — surface it as a TelegramError, not an opaque SyntaxError.
  const raw = await res.text();
  let body: {
    ok: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new TelegramError(res.status, `non-JSON response: ${raw.slice(0, 120)}`, null);
  }
  if (!body.ok) {
    throw new TelegramError(body.error_code ?? res.status, body.description ?? "unknown", body.parameters?.retry_after ?? null);
  }
  return body.result as T;
}

/**
 * Per-chat send pacing.
 *
 * Telegram allows roughly 1 message per second per chat
 * (docs/verification/2026-07-26-telegram-bot-api.md). Until p4-12 that was
 * enforced by a sleep inside each drain loop, which worked only because jobs
 * ran one after another. Concurrent jobs made every loop pace itself against
 * itself and nothing pace the chat: three notify-draining jobs in one tick
 * turned AAABBBCCC into ABCABCABC — three messages inside one 1100 ms window,
 * and TICK_JOB_CONCURRENCY=6 would make it six.
 *
 * So the gate belongs at the single choke point every caller already passes
 * through, not in the loops. Same reasoning as fetchPool's required
 * concurrency argument: put the guarantee where it cannot be forgotten. This
 * also covers poster.ts, deliver.ts and generate.ts, which never paced at all.
 *
 * A RESERVED TIMESTAMP, not a promise chain. The original implementation
 * chained promises, and the reasoning was sound (ordering matters as much as
 * the gap) but the mechanism was not survivable:
 *
 *   const hold = wait.then(() => new Promise((r) => setTimeout(r, spacingMs)));
 *   chatGates.set(chatId, hold.catch(() => {}));
 *   return wait;
 *
 * A Workers invocation does NOT run pending timers once it ends. When a tick's
 * last act was a send, the tick finished before that 1100 ms timer fired and
 * the stored promise NEVER RESOLVED. Every later send in that isolate awaited
 * it forever: no message, no rejection, no log. `crons = ["* * * * *"]` keeps
 * the isolate warm every 60 s, so nothing ever evicted it, and only a deploy
 * cleared it. On 2026-08-05 that silently cost ten hours of approval cards
 * (see docs/verification/2026-08-05-telegram-delivery-hang.md).
 *
 * ORDERING IS PRESERVED, which is why the original chose a chain. The slot is
 * reserved SYNCHRONOUSLY, before any await, so concurrent callers still
 * serialise in arrival order: each takes a strictly later slot than the one
 * before it.
 *
 * WHAT MAKES IT SURVIVABLE is that the cross-invocation state is a NUMBER. A
 * timer created here is awaited only by the invocation that created it, so an
 * invocation dying mid-wait harms only its own send. The next invocation reads
 * an integer, and the worst a stale integer can do is make one caller wait up
 * to MAX_PACE_WAIT_MS. It cannot hang.
 */
const nextSlotAt = new Map<string, number>();

/** Hard ceiling on any single pacing wait. Belt to the timestamp's braces: even
 *  a corrupted or absurdly future slot can only cost one spacing window, never
 *  a stalled tick. */
export const MAX_PACE_WAIT_MS = 5_000;

export function paceChat(chatId: string, spacingMs: number): Promise<void> {
  if (!(spacingMs > 0)) return Promise.resolve();
  const now = Date.now();
  // Reserve first, await second. The first send on a quiet chat sees a slot in
  // the past and goes immediately, paying only for the gap it leaves behind.
  const slot = Math.max(now, nextSlotAt.get(chatId) ?? 0);
  nextSlotAt.set(chatId, slot + spacingMs);
  const waitMs = Math.min(slot - now, MAX_PACE_WAIT_MS);
  if (waitMs <= 0) return Promise.resolve();
  return new Promise<void>((r) => setTimeout(r, waitMs));
}

/** Test seam: drop pacing state so one suite's sends cannot delay the next. */
export function resetChatPacing(): void {
  nextSlotAt.clear();
}

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  opts?: {
    buttons?: TgInlineButton[][];
    forceReply?: boolean;
    replyToMessageId?: number;
    monospace?: boolean;
    /** Milliseconds to hold the chat after this send. Callers pass
     *  QUEUE_NOTIFY_SPACING_MS; omitted means unpaced (webhook replies, which
     *  are user-triggered and one at a time). */
    spacingMs?: number;
  },
): Promise<TgMessageResult> {
  if (opts?.spacingMs) await paceChat(chatId, opts.spacingMs);
  const clamped = clampText(text);
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: clamped,
    link_preview_options: { is_disabled: true },
  };
  // One-tap copy WITHOUT parse_mode (the no-parse_mode rule stands: MarkdownV2
  // rejects unescaped . - ( ) and every numeric draft would 400). An explicit
  // entities array marks the whole message as a pre block — Telegram clients
  // render it monospace with a copy control, and no escaping is involved.
  if (opts?.monospace) payload.entities = [{ type: "pre", offset: 0, length: clamped.length }];
  if (opts?.buttons) payload.reply_markup = { inline_keyboard: opts.buttons };
  if (opts?.forceReply) payload.reply_markup = { force_reply: true, input_field_placeholder: "Corrected post text" };
  if (opts?.replyToMessageId) {
    payload.reply_parameters = { message_id: opts.replyToMessageId, allow_sending_without_reply: true };
  }
  return tgCall<TgMessageResult>(token, "sendMessage", payload);
}

/**
 * Edit a previous bot message. Omitting reply_markup removes the inline
 * keyboard. "message is not modified" (undocumented but ubiquitous 400) is
 * swallowed as a benign no-op so double-processing never throws.
 */
export async function editMessageText(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  opts?: { buttons?: TgInlineButton[][] },
): Promise<void> {
  try {
    await tgCall(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: clampText(text),
      link_preview_options: { is_disabled: true },
      ...(opts?.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    });
  } catch (e) {
    if (e instanceof TelegramError && e.errorCode === 400 && e.message.includes("message is not modified")) return;
    throw e;
  }
}

/** Mandatory after every callback button press (clients show a spinner until called). */
export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
  await tgCall(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}
