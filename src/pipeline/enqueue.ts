import type { Env } from "../env";
import { createQueueEntry, setQueueTelegramMessageId } from "../lib/db";
import { sendMessage, TelegramError } from "../lib/telegram";
import { renderForQueue } from "../templates";
import type { ArchetypeId, Payload } from "../templates/types";
import { log } from "../lib/log";

export interface EnqueueResult {
  queueId: number;
  notified: boolean;
  /** Set when Telegram flood control pushed back — callers should stop batching. */
  retryAfter: number | null;
}

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
  archetype: ArchetypeId,
  payload: Payload,
  sourceUrl: string,
  now: Date = new Date(),
  seed?: string,
): Promise<EnqueueResult> {
  // RENDER AT ENQUEUE TIME (persona.md: what Sahil approves is byte-identical
  // to what posts). Deterministic seed = the item's identity, so a re-render
  // produces the same text.
  const rendered = await renderForQueue(env, archetype, payload, seed ?? `${archetype}:${itemId}`);
  if (!rendered.ok) {
    // Park it in the lake rather than leaving status='new': the drain query
    // is ORDER BY id LIMIT N, so an unrenderable row would head-of-line block
    // its entire source forever.
    await env.DB.prepare(`UPDATE items SET status = 'logged' WHERE id = ?1`).bind(itemId).run().catch(() => {});
    log("error", "render failed; item parked as logged", { itemId, archetype, reason: rendered.reason });
    return { queueId: 0, notified: false, retryAfter: null };
  }
  const draftText = rendered.text;
  const queueId = await createQueueEntry(env.DB, itemId, archetype, draftText, now, {
    skeletonId: rendered.skeletonId,
    beatId: rendered.beatId,
  });

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log("warn", "telegram not configured; queue entry created without notification", { queueId });
    return { queueId, notified: false, retryAfter: null };
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
    return { queueId, notified: true, retryAfter: null };
  } catch (e) {
    // Queue row survives; the expiry job will sweep it if nobody notices.
    log("error", "telegram notify failed", { queueId, error: String(e) });
    const retryAfter = e instanceof TelegramError ? e.retryAfter : null;
    return { queueId, notified: false, retryAfter };
  }
}
