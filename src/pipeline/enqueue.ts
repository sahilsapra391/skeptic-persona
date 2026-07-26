import type { Env } from "../env";
import { createQueueEntry, setQueueTelegramMessageId } from "../lib/db";
import { sendMessage } from "../lib/telegram";
import { log } from "../lib/log";

/**
 * Put an item's draft into the approval queue and surface it in Telegram
 * with Approve / Edit / Reject buttons. Ingesters (PR-3+) call this for
 * every postable item while the category is approval-gated.
 *
 * If Telegram env isn't configured yet, the queue row is still created
 * (state pending) so nothing is lost — it will simply expire un-notified.
 */
export async function enqueueForApproval(
  env: Env,
  itemId: number,
  archetype: string,
  draftText: string,
  sourceUrl: string,
  now: Date = new Date(),
): Promise<number> {
  const queueId = await createQueueEntry(env.DB, itemId, archetype, draftText, now);

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log("warn", "telegram not configured; queue entry created without notification", { queueId });
    return queueId;
  }

  const text = `#${queueId} · ${archetype}\n\n${draftText}\n\nSource: ${sourceUrl}`;
  try {
    const msg = await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text, {
      buttons: [
        [
          { text: "✅ Approve", callback_data: `a:${queueId}` },
          { text: "✏️ Edit", callback_data: `e:${queueId}` },
          { text: "❌ Reject", callback_data: `r:${queueId}` },
        ],
      ],
    });
    await setQueueTelegramMessageId(env.DB, queueId, msg.message_id);
  } catch (e) {
    // Queue row survives; the expiry job will sweep it if nobody notices.
    log("error", "telegram notify failed", { queueId, error: String(e) });
  }
  return queueId;
}
