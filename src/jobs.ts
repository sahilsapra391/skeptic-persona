import type { Env } from "./env";
import { registry } from "./dispatch";
import { syncBlsCalendar, watchBls } from "./ingesters/bls";
import { pollEdgar8k } from "./ingesters/edgar8k";
import { pollFedPress } from "./ingesters/fedPress";
import { pollForm4 } from "./ingesters/form4";
import { pollForm144 } from "./ingesters/form144";
import { makeRateHandler, RATE_SOURCES } from "./ingesters/rates";
import { pollTreasury } from "./ingesters/treasury";
import { FDA_SOURCES, makeFdaHandler } from "./ingesters/fdaRecalls";
import { refreshIssuers } from "./ingesters/issuers";
import { captureEdgarBodies } from "./ingesters/edgarBody";
import { runSourceHealth } from "./sourceHealth";
import { pollFederalRegister } from "./ingesters/federalRegister";
import { pollCftc } from "./ingesters/cftc";
import { pollSchedule13 } from "./ingesters/schedule13d";
import { makePressHandler, PRESS_SOURCES } from "./ingesters/regulatoryPress";
import { pollEdgarReconcile } from "./ingesters/edgarReconcile";
import { pollRegSho } from "./ingesters/regsho";
import { pollForm25 } from "./ingesters/form25";
import { pollForm13f } from "./ingesters/form13f";
import { pollThirteenFCards } from "./ingesters/thirteenFCards";
import { pollNoaaStorms } from "./ingesters/noaaStorms";
import { pollNasdaqHalts, pollNyseHalts } from "./ingesters/halts";
import { pollHousePtr } from "./ingesters/housePtr";
import { pollSenatePtr } from "./ingesters/senatePtr";
import { runGeneration } from "./rag/generate";
import { runVoiceDigest } from "./rag/digest";
import { deliverCards } from "./rag/deliver";
import { newTickBudget, type TickBudget } from "./lib/budget";
import { expirePendingBefore } from "./lib/db";
import { pushDigests } from "./digest";
import { notifySpacingMs } from "./pipeline/enqueue";
import { editMessageText, sendMessage } from "./lib/telegram";
import { iso } from "./lib/time";
import { log } from "./lib/log";

// 48h since 2026-08-01 (owner decision, p4-00): posting is manual, so a card
// must survive a workday, not a wire cycle. The 6h default was the automated
// Threads era and produced the "Expired unapproved" flood.
export const DEFAULT_QUEUE_TTL_HOURS = 48;

/**
 * Per-archetype TTL overrides (owner decision, p4-00): macro prints and halts
 * are stale almost immediately; congress PTRs already carry a disclosure lag
 * of days, so two more days changes nothing about their value.
 */
export const DEFAULT_QUEUE_TTL_OVERRIDES: Record<string, number> = {
  MACRO_PRINT: 12,
  HALT: 12,
  CONGRESS_PTR: 96,
};

/**
 * Resolve the expiry cutoffs from env: QUEUE_TTL_HOURS is the fallback,
 * QUEUE_TTL_OVERRIDES ("ARCHETYPE:hours,ARCHETYPE:hours") merges over the
 * code defaults key by key. Invalid entries warn and are skipped, never
 * silently zeroed — a typo must not expire a category instantly.
 */
export function ttlCutoffs(env: Env, now: Date): { default: Date; byArchetype: Record<string, Date> } {
  const raw = Number(env.QUEUE_TTL_HOURS ?? DEFAULT_QUEUE_TTL_HOURS);
  const ttlHours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUEUE_TTL_HOURS;
  if (ttlHours !== raw) {
    log("warn", "invalid QUEUE_TTL_HOURS; using default", { raw: env.QUEUE_TTL_HOURS ?? null, ttlHours });
  }
  const hours: Record<string, number> = { ...DEFAULT_QUEUE_TTL_OVERRIDES };
  for (const entry of (env.QUEUE_TTL_OVERRIDES ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const m = /^([A-Z0-9_]+):(\d+(?:\.\d+)?)$/.exec(trimmed);
    const h = m ? Number(m[2]) : NaN;
    if (!m || !Number.isFinite(h) || h <= 0) {
      log("warn", "invalid QUEUE_TTL_OVERRIDES entry; skipped", { entry: trimmed });
      continue;
    }
    hours[m[1]!] = h;
  }
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const byArchetype: Record<string, Date> = {};
  for (const [arch, h] of Object.entries(hours)) byArchetype[arch] = at(h);
  return { default: at(ttlHours), byArchetype };
}

/** Attempts before a card is declared undeliverable and left for the sweep.
 *  Bounded so one permanently-rejected row cannot spend the notify budget
 *  every tick and starve every fresh card behind it. */
export const MAX_NOTIFY_ATTEMPTS = 5;
/** Rows re-notified per run. Small: this is a recovery path, not a drain. */
export const NOTIFY_RETRY_LIMIT = 5;

/**
 * notify_retry (migration 0064, cadence every_5m): re-send approval cards whose
 * Telegram notification never landed.
 *
 * WHY THIS EXISTS. enqueueForApproval writes the queue row and THEN notifies.
 * A failed notify left the row with telegram_message_id NULL and no retry
 * anywhere, so the card was invisible to the owner and aged out at TTL. The
 * comment in enqueue.ts described that as acceptable: "the expiry job will
 * sweep it if nobody notices." On 2026-08-05 nobody noticed for ten hours.
 *
 * The specific bug that caused it is fixed at its root in lib/telegram.ts.
 * This job exists because that was not the only way to lose a card: Telegram
 * can 429, 5xx, or be down, and every one of those must degrade to DELIVERED
 * LATE rather than LOST.
 *
 * Only rows still inside their TTL are retried. Re-notifying a card that is
 * about to expire would hand the owner something he cannot act on, which is
 * the "stale content is worthless" rule queue_expiry already encodes.
 */
export async function notifyRetry(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const cutoffs = ttlCutoffs(env, now);
  const rows = await env.DB.prepare(
    `SELECT q.id, q.archetype, COALESCE(q.edited_text, q.draft_text) AS draft_text,
            q.created_at, i.source_url
     FROM queue q JOIN items i ON i.id = q.item_id
     WHERE q.state = 'pending'
       AND q.telegram_message_id IS NULL
       AND q.notify_attempts < ?1
     ORDER BY q.id ASC
     LIMIT ?2`,
  )
    .bind(MAX_NOTIFY_ATTEMPTS, NOTIFY_RETRY_LIMIT)
    .all<{ id: number; archetype: string; draft_text: string; created_at: string; source_url: string }>();

  for (const row of rows.results) {
    // Inside its own TTL, using the same per-archetype cutoffs the sweep uses,
    // so the two jobs can never disagree about what is still live.
    const cutoff = cutoffs.byArchetype[row.archetype] ?? cutoffs.default;
    if (new Date(row.created_at) <= cutoff) continue;
    if (!budget.take(1)) break;
    // Count the attempt BEFORE sending. A send that throws after Telegram has
    // already accepted the message would otherwise retry forever and deliver
    // the same card repeatedly, which is worse than dropping it.
    await env.DB.prepare(`UPDATE queue SET notify_attempts = notify_attempts + 1 WHERE id = ?1`).bind(row.id).run();
    try {
      const msg = await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        `#${row.id} · ${row.archetype}\n\n${row.draft_text}\n\nSource: ${row.source_url}`,
        {
          spacingMs: notifySpacingMs(env),
          buttons: [
            [
              { text: "✅ Approve", callback_data: `a:${row.id}` },
              { text: "✏️ Edit", callback_data: `e:${row.id}` },
              { text: "❌ Reject", callback_data: `r:${row.id}` },
            ],
          ],
        },
      );
      await env.DB.prepare(`UPDATE queue SET telegram_message_id = ?1 WHERE id = ?2`).bind(msg.message_id, row.id).run();
      log("info", "undelivered card recovered", { queueId: row.id, archetype: row.archetype });
    } catch (e) {
      log("error", "notify retry failed", { queueId: row.id, error: String(e) });
    }
  }
}

/**
 * queue_expiry (seeded in migration 0002, cadence every_30m): wire-speed
 * content is worthless late, so pending drafts older than their archetype's
 * TTL are expired rather than posted stale. Also purges old webhook-dedup rows.
 */
async function queueExpiry(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  // Sweep is capped at EXPIRY_SWEEP_LIMIT rows (see db.ts) so one run stays
  // inside the tick's subrequest budget; a backlog drains across runs.
  const expired = await expirePendingBefore(env.DB, ttlCutoffs(env, now), now);

  for (const entry of expired) {
    log("info", "queue entry expired", { queueId: entry.id });
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) continue;
    // Badge edits are cosmetic; when the shared tick budget runs dry the
    // remaining badges are skipped (stale keyboards self-heal on tap).
    if (entry.telegramMessageId && budget.take(1)) {
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
    if (entry.editPromptMessageId && budget.take(1)) {
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
  registry["notify_retry"] = notifyRetry;
  registry["edgar_8k"] = pollEdgar8k;
  registry["edgar_form4"] = pollForm4;
  registry["sec_form144"] = pollForm144;
  // One job per rate source: each carries its own cadence and failure state.
  for (const src of RATE_SOURCES) registry[src.id] = makeRateHandler(src);
  registry["treasury_auction"] = pollTreasury;
  for (const src of FDA_SOURCES) registry[src.id] = makeFdaHandler(src);
  registry["issuer_refresh"] = refreshIssuers;
  registry["edgar_8k_body"] = captureEdgarBodies;
  registry["source_health"] = runSourceHealth;
  registry["federal_register"] = pollFederalRegister;
  registry["edgar_13f"] = pollForm13f;
  // D-28: the lane that fills the 13F tables never wrote to `items`. This is
  // the step that turns a parsed filing into a card. No external fetches, so
  // it is safe on a short cadence during the Aug-14 flood.
  registry["edgar_13f_breakdown"] = pollThirteenFCards;
  registry["cftc_cot"] = pollCftc;
  registry["sec_schedule13"] = pollSchedule13;
  for (const src of PRESS_SOURCES) registry[src.id] = makePressHandler(src);
  registry["edgar_reconcile"] = pollEdgarReconcile;
  registry["regsho_threshold"] = pollRegSho;
  registry["sec_form25"] = pollForm25;
  registry["noaa_storms"] = pollNoaaStorms;
  registry["senate_ptr"] = pollSenatePtr;
  registry["house_ptr"] = pollHousePtr;
  registry["fed_press"] = pollFedPress;
  registry["halts_nasdaq"] = pollNasdaqHalts;
  registry["halts_nyse"] = pollNyseHalts;
  registry["bls_calendar"] = syncBlsCalendar;
  registry["bls_watch"] = watchBls;
  registry["voice_digest"] = runVoiceDigest;
  // One tick: generate, then deliver any undelivered terminal rows —
  // including rows a previous crashed run generated but never delivered.
  registry["digest_push"] = pushDigests;
  registry["generation"] = async (env, now, budget) => {
    // DECOUPLED, deliberately. These were awaited in sequence, so anything
    // thrown by runGeneration skipped deliverCards entirely — and
    // deliverCards is not generation's downstream step, it delivers every
    // terminal row that has no live card, including ones generated on
    // PREVIOUS ticks. A persistent throw therefore stranded already-generated
    // commentary indefinitely: the work was done, the owner just never saw it.
    //
    // The throw is reachable: validateVariant is not wrapped anywhere in the
    // variant loop and it makes D1 calls (collisionCheck, corpusEchoCheck),
    // so a database hiccup is enough. Any future LLM-judge validator would
    // widen that surface considerably.
    //
    // Delivery runs regardless, and the generation failure is still surfaced
    // to the dispatcher so job health records it.
    let generationError: unknown = null;
    try {
      await runGeneration(env, now, budget);
    } catch (e) {
      generationError = e;
      log("error", "generation failed; delivering existing terminal rows anyway", { error: String(e) });
    }
    await deliverCards(env, now, budget);
    if (generationError !== null) throw generationError;
  };
  // 'poster' and 'threads_token_refresh' are UNREGISTERED as of 2026-07-28:
  // the Threads account is banned and both job rows are disabled in migration
  // 0026. Their handlers still exist (src/poster.ts, THREADS_PARKED) for the
  // appeal. Re-enabling a row without reverting the code logs a "no handler
  // registered" warn rather than silently doing nothing, which is the failure
  // mode we want. The 'generation' job registered above is the poster's
  // replacement: it produces copy-ready variants; the OWNER publishes.
}
