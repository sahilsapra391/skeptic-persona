# Telegram Bot API verification — 2026-07-26 (PR-2)

Checked live 2026-07-26 ~23:05 UTC: core.telegram.org/bots/api,
core.telegram.org/bots/webhooks, core.telegram.org/bots/faq (all 200,
server-rendered HTML), plus live probes of api.telegram.org.

## Facts the PR-2 code encodes

- **Webhook auth:** `setWebhook` `secret_token` (1–256 chars, charset
  `A-Za-z0-9_-` only) is echoed on every update POST in the header
  **`X-Telegram-Bot-Api-Secret-Token`** — this is the route's auth check
  (timing-safe compare).
- **Delivery/retry:** one JSON `Update` per POST; any non-2xx response makes
  Telegram retry "a reasonable amount of attempts" (cadence undocumented;
  undelivered updates dropped after 24 h). Therefore: dedupe on `update_id`
  **equality** (ids restart randomly after ≥1 week idle — never use
  monotonicity), and return 200 even when a side-effect fails.
- **Update shape:** `{update_id, message? | callback_query?}` — at most one
  optional field per update. `allowed_updates: ["message","callback_query"]`.
- **CallbackQuery:** `{id, from, message?, data?}`; `data` is
  client-supplied — validate server-side (doc warns the originating message
  "can contain no callback buttons with this data"). `answerCallbackQuery`
  is mandatory (clients spin until it's called). `CallbackQuery.message` may
  be an `InaccessibleMessage` (`date === 0`).
- **Buttons:** `reply_markup: {inline_keyboard: [[{text, callback_data}]]}`;
  `callback_data` limit is **1–64 BYTES**. No documented row/button count
  limit — don't rely on folklore numbers.
- **ForceReply:** `{force_reply: true, input_field_placeholder?}`; the
  owner's reply arrives as a message with `reply_to_message.message_id`
  equal to the prompt's id (nested replies are not populated further).
- **sendMessage:** `text` 1–4096 chars **after entity parsing**; overflow
  behavior undocumented → clamp client-side. Link previews off via
  `link_preview_options: {is_disabled: true}` (`disable_web_page_preview` no
  longer exists).
- **Reply threading:** `reply_parameters` object —
  `{message_id: Integer, allow_sending_without_reply: Boolean}`
  (`ReplyParameters`); `allow_sending_without_reply: true` still sends when
  the referenced message is gone, so stale references can't 400 a
  confirmation. Field names confirmed on the live Bot API page.
- **parse_mode decision: NONE (plain text).** MarkdownV2 reserves
  `. - ( ) ! + = | # >` etc. — every numeric draft ("3.2%", "-4.1")
  would 400 with can't-parse-entities unless escaped. Plain text renders
  everything; HTML (3 escapes) is the fallback if formatting is ever needed.
- **editMessageText/ReplyMarkup:** no time limit for a bot editing its own
  messages (the 48 h limits apply to business messages and deleteMessage).
  Omitting `reply_markup` on edit removes the keyboard. The ubiquitous 400
  "message is not modified" is NOT in the docs — client swallows it as a
  no-op; confirm once with the real bot (unverifiable tokenless).
- **Rate limits (bots/faq):** ~1 msg/s per chat, ~30 msg/s overall.
  429 shape: `{ok:false, error_code:429, parameters:{retry_after: N}}`.
  Trivial at approval-queue volume.
- **Error envelope:** always `{ok, result | error_code, description,
  parameters?}`. Live probe: invalid token = clean HTTP **401**
  `{"ok":false,"error_code":401,"description":"Unauthorized"}` — status
  class IS trustworthy here (unlike Threads' 500/code-190).
- **getUpdates ↔ webhook are mutually exclusive** (both directions
  documented). Owner's one-time chat-id discovery must run BEFORE
  `setWebhook`: DM the bot, `getUpdates`, read `message.chat.id`.
- **Webhook infra:** ports 443/80/88/8443 only, IPv4 POSTs from
  `149.154.160.0/20` / `91.108.4.0/22`, TLS 1.2+. workers.dev on 443 ✓.
- **Ids:** chat/user ids up to 52 significant bits — safe as JS numbers,
  but compared as STRINGS against `TELEGRAM_CHAT_ID`.

## Unverified (needs the real bot during owner setup)

- Exact 400 text for >4096-char sends (clamped client-side anyway).
- "message is not modified" 400 wording (handled defensively).
