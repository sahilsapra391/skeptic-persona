export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  CONTACT_EMAIL: string;
  POSTING_ENABLED: string;
  // Telegram approval queue (PR-2). Optional so the Worker boots before the
  // owner has configured the bot; features degrade with a warn log.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  QUEUE_TTL_HOURS?: string;
  /** Ms between batched queue notifications (Telegram asks ≤1 msg/s per chat). Default 1100; tests use 0. */
  QUEUE_NOTIFY_SPACING_MS?: string;
  /** BLS watcher tight-poll tuning (defaults 2500 / 90000; tests shrink them). */
  BLS_POLL_INTERVAL_MS?: string;
  BLS_POLL_DEADLINE_MS?: string;
}
