import type { Env } from "../env";
import type { TickBudget } from "../lib/budget";
import { newTickBudget } from "../lib/budget";
import { sendMessage } from "../lib/telegram";
import { log } from "../lib/log";
import { recentEditedPairs, zeroEditStats, type EditPair, type ZeroEditStats } from "./learn";

// P4-09: the nightly report the owner reads to decide whether any of this is
// working. It leads with the zero-edit rate because that is the track's stated
// goal — a post copy-pasted to X with zero edits.
//
// The wording rules here are the whole point of the file:
//
//  * NO DATA IS SAID AS NO DATA. A pipeline that has published nothing has no
//    zero-edit rate; rendering that as "0%" would report a failure that never
//    happened, and rendering it as "100%" would report a success that never
//    happened. Both are the silent-success shape this project keeps paying
//    for, which is why the digest states the count first and the rate second.
//  * A DENOMINATOR IS ALWAYS SHOWN. "100%" over two posts is not a finding.
//  * UNCAPTURED PAIRS ARE NAMED, not folded into either bucket.

/** Rolling window for the headline. Seven days survives a quiet weekend. */
export const DIGEST_WINDOW_DAYS = 7;
/** Edited pairs quoted in full. Enough to see a pattern, few enough to read. */
export const DIGEST_PAIR_LIMIT = 3;

const DAY_MS = 86_400_000;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Exported for tests, and because the wording IS the feature: a reviewer
 * should be able to read the no-data branch without standing up a database.
 */
export function renderDigest(stats: ZeroEditStats, pairs: readonly EditPair[], windowDays: number): string {
  const lines: string[] = [`Skeptic Wire — voice digest, last ${windowDays} days`, ""];
  const scoreable = stats.unedited + stats.edited;

  if (stats.posted === 0) {
    lines.push("Zero-edit rate: no posts published in the window, so there is no rate to report.");
    lines.push("This is not a score of 0%. Nothing has been measured yet.");
    return lines.join("\n");
  }

  if (scoreable === 0) {
    lines.push(
      `Zero-edit rate: unmeasurable. ${stats.posted} post(s) published, but none carries a captured draft`,
      "to compare against, so there is nothing to score. (Pairs are captured from p4-09 onward.)",
    );
    return lines.join("\n");
  }

  lines.push(
    `Zero-edit rate: ${pct(stats.rate ?? 0)} — ${stats.unedited} of ${scoreable} published post(s) went out exactly as generated.`,
  );
  if (scoreable < 5) {
    lines.push(`Small sample: ${scoreable} post(s). Treat the number as a direction, not a measurement.`);
  }
  if (stats.uncaptured > 0) {
    lines.push(`${stats.uncaptured} further post(s) had no captured draft and are excluded from the rate, not counted as edits.`);
  }
  if (stats.meanEditRatio !== null) {
    lines.push(`On the ${stats.edited} edited post(s), the owner changed ${pct(stats.meanEditRatio)} of the text on average.`);
  }

  if (pairs.length > 0) {
    lines.push("", "What changed:");
    for (const p of pairs) {
      lines.push(
        "",
        `#${p.queueId} ${p.archetype} (${p.variant ?? "unknown"}) — ${pct(p.ratio)} rewritten`,
        `  drafted: ${p.draft}`,
        `  posted:  ${p.final}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * The nightly job. Registered as 'voice_digest' on the daily_1330_utc profile
 * (09:30 ET, before the filing window opens, so yesterday is complete).
 */
export async function runVoiceDigest(env: Env, now: Date, _budget: TickBudget = newTickBudget()): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return; // not configured
  const since = new Date(now.getTime() - DIGEST_WINDOW_DAYS * DAY_MS);
  const stats = await zeroEditStats(env.DB, since);
  // Only fetch pairs there are pairs to fetch.
  const pairs = stats.edited > 0 ? await recentEditedPairs(env.DB, since, DIGEST_PAIR_LIMIT) : [];
  const text = renderDigest(stats, pairs, DIGEST_WINDOW_DAYS);
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  } catch (e) {
    // A failed digest must not retry-storm or mark the job failed: it is a
    // report, not a pipeline stage, and the next one carries the same window.
    log("warn", "voice digest send failed", { error: String(e) });
  }
}
