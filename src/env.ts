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
  /** Per-archetype TTL overrides, "ARCHETYPE:hours,..." — merged key-by-key over the code defaults (see jobs.ts). */
  QUEUE_TTL_OVERRIDES?: string;
  /** p4-03 salience: minimum score to push a card (default 45, range 0-100). Below it the item goes to the day's digest. */
  SALIENCE_FLOOR?: string;
  /** p4-03: per-archetype daily push caps, "ARCHETYPE:n,..." merged over the code defaults (src/salience.ts). */
  CATEGORY_DAILY_CAPS?: string;
  /** p4-03: a score at or above this ignores the daily category cap (default 80; 0 disables caps entirely). */
  CAP_BYPASS_SCORE?: string;
  /** Minimum issuer public float (USD) for a filing to reach the queue. */
  MIN_ISSUER_FLOAT_USD?: string;
  /** Ms between batched queue notifications (Telegram asks ≤1 msg/s per chat). Default 1100; tests use 0. */
  QUEUE_NOTIFY_SPACING_MS?: string;
  THIRTEENF_INLINE_MAX_BYTES?: string;
  SANITY_MAX_TOTAL_USD?: string;
  SANITY_MAX_POSITION_USD?: string;
  SANITY_MIN_TOTAL_USD?: string;
  OPENFIGI_API_KEY?: string;
  /** Shared secret for the GitHub Actions ingest relay (blocked sources). */
  INGEST_SECRET?: string;
  /** Jobs run concurrently per tick (default 3, max 6 — the Workers outbound-connection ceiling). */
  TICK_JOB_CONCURRENCY?: string;
  /** Wall-clock ms a tick may run before it stops starting new jobs (default 60000). */
  TICK_TIME_BUDGET_MS?: string;
  /** BLS watcher tight-poll tuning (defaults 2500 / 90000; tests shrink them). */
  BLS_POLL_INTERVAL_MS?: string;
  BLS_POLL_DEADLINE_MS?: string;
  // Threads poster (P2) — PARKED 2026-07-28, account banned (poster.ts
  // THREADS_PARKED). The secrets are still set in Cloudflare and the types
  // stay so the parked client keeps typechecking for the appeal; nothing
  // reads them while parked.
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
  /** Editorial posts/day cap (default 25). Unused while the publish path is parked. */
  POST_DAILY_CAP?: string;
  // Generation (P2-R p2r-04). Key is a secret; model id is config, never code.
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
}
