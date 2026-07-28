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

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  opts?: { buttons?: TgInlineButton[][]; forceReply?: boolean; replyToMessageId?: number; monospace?: boolean },
): Promise<TgMessageResult> {
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
