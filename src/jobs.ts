import type { Env } from "./env";
import { registry } from "./dispatch";
import { pollEdgar8k } from "./ingesters/edgar8k";
import { expirePendingBefore } from "./lib/db";
import { editMessageText } from "./lib/telegram";
import { iso } from "./lib/time";
import { log } from "./lib/log";

export const DEFAULT_QUEUE_TTL_HOURS = 6;

/**
 * queue_expiry (seeded in migration 0002, cadence every_30m): wire-speed
 * content is worthless late, so pending drafts older than QUEUE_TTL_HOURS
 * are expired rather than posted stale. Also purges old webhook-dedup rows.
 */
async function queueExpiry(env: Env, now: Date): Promise<void> {
  const raw = Number(env.QUEUE_TTL_HOURS ?? DEFAULT_QUEUE_TTL_HOURS);
  const ttlHours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUEUE_TTL_HOURS;
  if (ttlHours !== raw) {
    log("warn", "invalid QUEUE_TTL_HOURS; using default", { raw: env.QUEUE_TTL_HOURS ?? null, ttlHours });
  }
  const cutoff = new Date(now.getTime() - ttlHours * 3_600_000);
  // Sweep is capped at EXPIRY_SWEEP_LIMIT rows (see db.ts) so one run stays
  // inside the tick's subrequest budget; a backlog drains across runs.
  const expired = await expirePendingBefore(env.DB, cutoff, now);

  for (const entry of expired) {
    log("info", "queue entry expired", { queueId: entry.id });
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) continue;
    if (entry.telegramMessageId) {
      try {
        await editMessageText(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          entry.telegramMessageId,
          `⏰ Expired unapproved\n\n${entry.draftText}`,
        );
      } catch (e) {
        log("warn", "could not mark expired message in telegram", { queueId: entry.id, error: String(e) });
      }
    }
    // An outstanding force-reply prompt would keep inviting a reply that can
    // no longer apply — badge it too.
    if (entry.editPromptMessageId) {
      try {
        await editMessageText(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          entry.editPromptMessageId,
          `⏰ #${entry.id} expired; this edit prompt is no longer active.`,
        );
      } catch (e) {
        log("warn", "could not mark expired edit prompt", { queueId: entry.id, error: String(e) });
      }
    }
  }

  // Webhook dedup rows are only needed for Telegram's retry window (<24h);
  // keep a week, then purge.
  await env.DB.prepare(`DELETE FROM processed_updates WHERE received_at <= ?1`)
    .bind(iso(new Date(now.getTime() - 7 * 86_400_000)))
    .run();
}

/** Idempotent; called once at Worker module init. Ingester PRs add theirs here. */
export function registerJobs(): void {
  registry["queue_expiry"] = queueExpiry;
  registry["edgar_8k"] = pollEdgar8k;
}
