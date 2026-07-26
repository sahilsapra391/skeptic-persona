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
}
