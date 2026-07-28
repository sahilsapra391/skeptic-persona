import type { Env } from "./env";
import { registry } from "./dispatch";
import { syncBlsCalendar, watchBls } from "./ingesters/bls";
import { pollEdgar8k } from "./ingesters/edgar8k";
import { pollFedPress } from "./ingesters/fedPress";
import { pollForm4 } from "./ingesters/form4";
import { pollForm144 } from "./ingesters/form144";
import { makeRateHandler, RATE_SOURCES } from "./ingesters/rates";
import { pollTreasury } from "./ingesters/treasury";
import { pollFdaRecalls } from "./ingesters/fdaRecalls";
import { pollFederalRegister } from "./ingesters/federalRegister";
import { pollCftc } from "./ingesters/cftc";
import { pollSchedule13 } from "./ingesters/schedule13d";
import { makePressHandler, PRESS_SOURCES } from "./ingesters/regulatoryPress";
import { pollEdgarReconcile } from "./ingesters/edgarReconcile";
import { pollRegSho } from "./ingesters/regsho";
import { pollForm25 } from "./ingesters/form25";
import { pollNoaaStorms } from "./ingesters/noaaStorms";
import { pollNasdaqHalts, pollNyseHalts } from "./ingesters/halts";
import { pollHousePtr } from "./ingesters/housePtr";
import { pollSenatePtr } from "./ingesters/senatePtr";
import { runGeneration } from "./rag/generate";
import { newTickBudget, type TickBudget } from "./lib/budget";
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
async function queueExpiry(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
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
  registry["edgar_8k"] = pollEdgar8k;
  registry["edgar_form4"] = pollForm4;
  registry["sec_form144"] = pollForm144;
  // One job per rate source: each carries its own cadence and failure state.
  for (const src of RATE_SOURCES) registry[src.id] = makeRateHandler(src);
  registry["treasury_auction"] = pollTreasury;
  registry["fda_drug_recall"] = pollFdaRecalls;
  registry["federal_register"] = pollFederalRegister;
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
  registry["generation"] = runGeneration;
  // 'poster' and 'threads_token_refresh' are UNREGISTERED as of 2026-07-28:
  // the Threads account is banned and both job rows are disabled in migration
  // 0026. Their handlers still exist (src/poster.ts, THREADS_PARKED) for the
  // appeal. Re-enabling a row without reverting the code logs a "no handler
  // registered" warn rather than silently doing nothing, which is the failure
  // mode we want. The generation job that replaces the poster lands in p2r-04.
}
