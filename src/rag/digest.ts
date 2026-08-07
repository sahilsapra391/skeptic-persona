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
 * The counts that are deliberately EXCLUDED from the rate, reported wherever
 * the rate is reported. Shared by both branches because the no-score branch is
 * exactly where they matter most: "nothing to score" reads like a quiet week,
 * while "all six came from the fallback" reads like a broken generator, and
 * they can be the same underlying data.
 */
function residualLines(stats: ZeroEditStats): string[] {
  const out: string[] = [];
  if (stats.uncaptured > 0) {
    out.push(`${stats.uncaptured} post(s) had no captured draft and are excluded from the rate, not counted as edits.`);
  }
  if (stats.templateFallbacks > 0) {
    // Named, never folded in: a template ships unedited by definition, so
    // counting it would make this number RISE whenever generation failed.
    out.push(
      `${stats.templateFallbacks} post(s) came from the TEMPLATE fallback, not from generation, and are excluded`,
      "from the rate. A high count here means generation is failing, whatever the rate says.",
    );
  }
  return out;
}

/**
 * THE NORTH STAR (p5-06). Approval rate and post rate, trended week over week.
 *
 * "Coverage is measured by what the desk publishes, not by what it ingests.
 * 16,882 items and zero posts is the number this program exists to never
 * repeat." Both rates are computed over ONE COHORT, the cards created in the
 * window, so the funnel is card -> approval -> post on the same denominator
 * rather than three windows that quietly disagree.
 */
export interface NorthStar {
  readonly cards: number;
  readonly approvals: number;
  readonly manualPosts: number;
  /** Threads-era automated posts. Counted, reported, and NEVER in the rate. */
  readonly legacyAutoPosts: number;
}

/**
 * APPROVALS ARE A UNION, and getting this wrong has already produced a wrong
 * finding once. Counting `queue.state='approved'` alone reported press
 * converting 23x better than everything else and nearly sized a tier design
 * against it; the true figure is state UNION post_log, because an approved
 * card that went on to post no longer carries the 'approved' state. PR #115:
 *
 *     queue.state='approved'   2
 *     rows in post_log        18
 *     union                   20  of 920 = 2.17%
 *
 * 'edited' counts as an approval for the same reason deliverCards treats it as
 * one: it is approved-with-changes, not a rejection.
 */
async function cohort(db: D1Database, sinceIso: string, untilIso: string): Promise<NorthStar> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS cards,
         SUM(CASE WHEN q.state IN ('approved','edited')
                    OR EXISTS(SELECT 1 FROM post_log p WHERE p.queue_id = q.id)
                  THEN 1 ELSE 0 END) AS approvals,
         SUM(CASE WHEN EXISTS(SELECT 1 FROM post_log p
                              WHERE p.queue_id = q.id AND p.posted_manually = 1)
                  THEN 1 ELSE 0 END) AS manual_posts,
         SUM(CASE WHEN EXISTS(SELECT 1 FROM post_log p
                              WHERE p.queue_id = q.id AND p.posted_manually = 0)
                  THEN 1 ELSE 0 END) AS legacy_posts
       FROM queue q
       WHERE q.created_at >= ?1 AND q.created_at < ?2`,
    )
    .bind(sinceIso, untilIso)
    .first<{ cards: number; approvals: number; manual_posts: number; legacy_posts: number }>();
  return {
    cards: row?.cards ?? 0,
    approvals: row?.approvals ?? 0,
    manualPosts: row?.manual_posts ?? 0,
    legacyAutoPosts: row?.legacy_posts ?? 0,
  };
}

export async function northStarStats(
  db: D1Database,
  now: Date,
  windowDays: number = DIGEST_WINDOW_DAYS,
): Promise<{ current: NorthStar; prior: NorthStar }> {
  const ms = windowDays * DAY_MS;
  const until = now.toISOString();
  const since = new Date(now.getTime() - ms).toISOString();
  const priorSince = new Date(now.getTime() - 2 * ms).toISOString();
  return { current: await cohort(db, since, until), prior: await cohort(db, priorSince, since) };
}

/** Direction only. A delta on a two-card week is noise dressed as a trend, so
 *  the arrow is never shown without both counts beside it. */
function trend(now: number, before: number): string {
  if (before === 0 && now === 0) return "";
  if (before === 0) return ` (up from 0 last week)`;
  const delta = Math.round(((now - before) / before) * 100);
  if (delta === 0) return ` (flat vs last week)`;
  return ` (${delta > 0 ? "up" : "down"} ${Math.abs(delta)}% vs last week, from ${before})`;
}

/**
 * SENATE eFD ARRIVAL LATENCY (p5-12). How long after a senator files does the
 * filing actually reach us.
 *
 * MEASURED FORWARD, NOT BACKWARD, and that is the whole design. Migration 0059
 * made the same point about poll counters: a source that fails two polls in
 * three leaves no trace, because `last_ok_at` is overwritten by every success
 * and `consecutive_failures` resets. The evidence for "were our polls failing,
 * or does eFD index late" had already been destroyed by the time anyone asked.
 * This reports from stored, non-overwritten rows so the question stays
 * answerable next week.
 *
 * TWO NUMBERS, NEVER ONE. Latency alone cannot distinguish eFD publishing late
 * from us polling badly, and those imply different fixes (a freshness
 * allowance versus a retry). So the line carries the poll-failure counter
 * beside it. `total_failures` is lifetime and monotonic by design (0059 named
 * it `total_` precisely so nobody reads it as "now"), so it is labelled as
 * lifetime rather than folded into the window.
 */
export interface EfdLatency {
  readonly filings: number;
  readonly medianDays: number | null;
  readonly maxDays: number | null;
  readonly lifetimePollFailures: number;
  readonly consecutiveFailures: number;
  readonly lastOkAt: string | null;
}

export async function efdLatency(db: D1Database, since: Date): Promise<EfdLatency> {
  const rows = await db
    .prepare(
      `SELECT (julianday(fetched_at) - julianday(event_at)) AS days
       FROM items
       WHERE source = 'senate_ptr' AND event_at IS NOT NULL AND fetched_at >= ?1
       ORDER BY days`,
    )
    .bind(since.toISOString())
    .all<{ days: number }>();
  const days = rows.results.map((r) => r.days).filter((d) => Number.isFinite(d));
  const state = await db
    .prepare(`SELECT total_failures, consecutive_failures, last_ok_at FROM source_state WHERE source = 'senate_ptr'`)
    .first<{ total_failures: number; consecutive_failures: number; last_ok_at: string | null }>();
  return {
    filings: days.length,
    medianDays: days.length === 0 ? null : days[Math.floor((days.length - 1) / 2)]!,
    maxDays: days.length === 0 ? null : days[days.length - 1]!,
    lifetimePollFailures: state?.total_failures ?? 0,
    consecutiveFailures: state?.consecutive_failures ?? 0,
    lastOkAt: state?.last_ok_at ?? null,
  };
}

export function renderEfdLatency(l: EfdLatency, windowDays: number): string[] {
  const lines: string[] = [`Senate eFD arrival latency, last ${windowDays} days:`];
  if (l.filings === 0) {
    // No filings is NOT zero latency. It is either a quiet week or a lane that
    // stopped arriving, and the poll counters are what tell those apart.
    lines.push("  No filings arrived in the window, so there is no latency to report.");
  } else {
    lines.push(
      `  ${l.filings} filing(s): median ${l.medianDays!.toFixed(1)} days from filing to ingest, slowest ${l.maxDays!.toFixed(1)}`,
    );
    if (l.filings < 5) {
      lines.push(`  Small sample: ${l.filings} filing(s). A direction, not a measurement.`);
    }
  }
  // Always shown, including on the no-filings branch, because "quiet week" and
  // "we never successfully polled" produce identical filing counts.
  lines.push(
    `  Polling: ${l.consecutiveFailures} consecutive failure(s) now, ${l.lifetimePollFailures} lifetime` +
      `${l.lastOkAt ? `, last success ${l.lastOkAt.slice(0, 16).replace("T", " ")}Z` : ", never succeeded"}`,
  );
  if (l.lifetimePollFailures > 0 && l.filings > 0) {
    lines.push("  Latency above includes our polling gap, not eFD's publishing lag alone.");
  }
  return lines;
}

/**
 * Exported for tests, and because the wording IS the feature.
 *
 * THE GUARD ON EVERY RATE HERE IS THE DENOMINATOR, NOT THE NUMERATOR. Zero
 * posts out of 29 approvals is a real, measured, and extremely important 0%:
 * it is the exact fact the program exists to change. Zero approvals out of
 * zero cards is not a rate at all. Conflating the two would either hide the
 * finding or invent one.
 */
export function renderNorthStar(current: NorthStar, prior: NorthStar, windowDays: number): string[] {
  const lines: string[] = [`North star, last ${windowDays} days:`];

  if (current.cards === 0) {
    lines.push("  No cards were created in the window, so there is no approval rate to report.");
  } else {
    const rate = Math.round((current.approvals / current.cards) * 100);
    lines.push(
      `  Approval rate: ${rate}% — ${current.approvals} of ${current.cards} card(s)${trend(current.approvals, prior.approvals)}`,
    );
  }

  if (current.approvals === 0) {
    lines.push("  Post rate: no approvals in the window, so there is nothing that could have been posted.");
  } else {
    const rate = Math.round((current.manualPosts / current.approvals) * 100);
    lines.push(
      `  Post rate: ${rate}% — ${current.manualPosts} of ${current.approvals} approval(s) posted${trend(current.manualPosts, prior.manualPosts)}`,
    );
    if (current.manualPosts === 0) {
      // Said out loud rather than left as a 0%. This is the binding constraint
      // of the whole program, not a quiet metric.
      lines.push("  Nothing has been published from this window. The Copy button is the constraint, not the queue.");
    }
  }

  if (current.legacyAutoPosts > 0) {
    // NAMED, NEVER FOLDED IN — the same rule residualLines applies. These are
    // Threads-era AUTOMATED posts from before the ban. Counting them would
    // report a post rate the desk never achieved by hand, on a platform it no
    // longer publishes to, which is the silent-success shape this file exists
    // to refuse.
    lines.push(
      `  ${current.legacyAutoPosts} Threads-era automated post(s) in this cohort are excluded from the post rate.`,
      "  They were published by the parked auto-poster, not by the owner, and not to X.",
    );
  }
  return lines;
}

/**
 * Exported for tests, and because the wording IS the feature: a reviewer
 * should be able to read the no-data branch without standing up a database.
 */
export interface LaneRate {
  readonly archetype: string;
  readonly cards: number;
  readonly approvals: number;
  readonly posts: number;
}

/**
 * Per-lane approval and post rates (owner instruction, p5-20: "wire per-lane
 * approval rate into the digest as the lane ships").
 *
 * SAME COHORT AND SAME UNION as the north star, deliberately: cards, approvals
 * and posts are all counted over queue rows CREATED in the window, and an
 * approval is `state IN ('approved','edited')` UNION an existing post_log row.
 * Counting state alone loses every card that went on to post, which PR #115
 * measured as the difference between 0.22% and 2.17% pipeline-wide.
 *
 * Lane value is what this measures. A lane that cards a lot and gets approved
 * rarely is costing the owner attention, and that should be visible per lane
 * rather than averaged into one number.
 */
export async function laneRates(db: D1Database, sinceIso: string, untilIso: string): Promise<LaneRate[]> {
  const rows = await db
    .prepare(
      `SELECT q.archetype AS archetype,
              COUNT(*) AS cards,
              SUM(CASE WHEN q.state IN ('approved','edited')
                         OR EXISTS(SELECT 1 FROM post_log p WHERE p.queue_id = q.id)
                       THEN 1 ELSE 0 END) AS approvals,
              SUM(CASE WHEN EXISTS(SELECT 1 FROM post_log p
                                   WHERE p.queue_id = q.id AND p.posted_manually = 1)
                       THEN 1 ELSE 0 END) AS posts
       FROM queue q
       WHERE q.created_at >= ?1 AND q.created_at < ?2
       GROUP BY q.archetype
       ORDER BY cards DESC`,
    )
    .bind(sinceIso, untilIso)
    .all<LaneRate>();
  return rows.results;
}

export function renderLaneRates(lanes: readonly LaneRate[]): string[] {
  if (lanes.length === 0) return [];
  const out = ["", "Per lane, this window:"];
  for (const l of lanes) {
    // A lane with no cards cannot have a rate; it is simply absent from the
    // GROUP BY, so every row here has cards >= 1 and the division is safe.
    const approval = Math.round((l.approvals / l.cards) * 100);
    const posted = l.approvals > 0 ? `, ${l.posts} posted` : "";
    out.push(`  ${l.archetype}: ${approval}% approved — ${l.approvals} of ${l.cards}${posted}`);
  }
  return out;
}

/**
 * Generation health per archetype (B-08.6): how often a lane ends up with a
 * template card instead of a voice, and what refused it.
 *
 * api_error/api_failed are counted SEPARATELY from rejections and never folded
 * into the fallback rate. They are different failures with different fixes:
 * a rejection means the copy was judged and refused, an API failure means it
 * was never judged at all. Card #1236 fell back after four API failures with
 * zero gate contact (D-75), and a combined number would have read as a voice
 * problem and sent the next reader to the wrong place entirely.
 */
export interface GenHealth {
  archetype: string;
  cards: number;
  fell_back: number;
  api_cards: number;
  top_reason: string | null;
  top_reason_n: number;
}

export async function genHealth(db: D1Database, sinceIso: string, untilIso: string): Promise<GenHealth[]> {
  const rows = await db
    .prepare(
      `SELECT q.archetype AS archetype,
              COUNT(DISTINCT g.queue_id) AS cards,
              COUNT(DISTINCT CASE WHEN g.status IN ('fallback_template','fallback_blocked','skipped_no_exemplar')
                                  THEN g.queue_id END) AS fell_back,
              COUNT(DISTINCT CASE WHEN g.status IN ('api_error','api_failed') THEN g.queue_id END) AS api_cards
         FROM generations g JOIN queue q ON q.id = g.queue_id
        WHERE g.created_at >= ?1 AND g.created_at < ?2
        GROUP BY q.archetype
        ORDER BY fell_back DESC, cards DESC`,
    )
    .bind(sinceIso, untilIso)
    .all<{ archetype: string; cards: number; fell_back: number; api_cards: number }>();

  const reasons = await db
    .prepare(
      `SELECT q.archetype AS archetype, g.status AS status, COUNT(*) AS n
         FROM generations g JOIN queue q ON q.id = g.queue_id
        WHERE g.created_at >= ?1 AND g.created_at < ?2 AND g.status LIKE 'rejected:%'
        GROUP BY q.archetype, g.status
        ORDER BY n DESC`,
    )
    .bind(sinceIso, untilIso)
    .all<{ archetype: string; status: string; n: number }>();

  const top = new Map<string, { status: string; n: number }>();
  for (const r of reasons.results) if (!top.has(r.archetype)) top.set(r.archetype, { status: r.status, n: r.n });

  return rows.results.map((r) => ({
    ...r,
    top_reason: top.get(r.archetype)?.status.replace("rejected:", "") ?? null,
    top_reason_n: top.get(r.archetype)?.n ?? 0,
  }));
}

export function renderGenHealth(rows: readonly GenHealth[]): string[] {
  if (rows.length === 0) return [];
  const cards = rows.reduce((a, r) => a + r.cards, 0);
  const fell = rows.reduce((a, r) => a + r.fell_back, 0);
  if (cards === 0) return [];
  const pct = Math.round((fell / cards) * 100);
  // B-08.7's acceptance number, tracked from now on rather than measured once.
  const out = ["", `Generation: ${pct}% fallback (${fell} of ${cards} cards). Target under 10%. Baseline 36%.`];
  for (const r of rows) {
    if (r.fell_back === 0 && r.api_cards === 0) continue;
    const why = r.top_reason ? `, top reason ${r.top_reason} x${r.top_reason_n}` : "";
    // API trouble is named apart, because it is not a voice problem.
    const api = r.api_cards > 0 ? `, ${r.api_cards} hit the API` : "";
    out.push(`  ${r.archetype}: ${r.fell_back}/${r.cards} fell back${why}${api}`);
  }
  return out;
}

export function renderDigest(
  stats: ZeroEditStats,
  pairs: readonly EditPair[],
  windowDays: number,
  northStar: readonly string[] = [],
  efd: readonly string[] = [],
): string {
  const lines: string[] = [`Skeptic Wire — voice digest, last ${windowDays} days`, ""];
  // FIRST, and above the zero-edit rate on purpose. The zero-edit rate scores
  // the drafts we produce; the north star scores whether any of them reach the
  // public. With zero posts the second is the only one of the two that can say
  // anything, and it is also the branch where renderDigest returns earliest —
  // so it goes here, before any early return can skip it.
  if (northStar.length > 0) lines.push(...northStar, "");
  // Beside the north star rather than at the end, for the same reason: the
  // early returns below skip everything after them, and a lane that has
  // stopped arriving is exactly what a zero-post week needs to surface.
  if (efd.length > 0) lines.push(...efd, "");
  const scoreable = stats.unedited + stats.edited;

  if (stats.posted === 0) {
    lines.push("Zero-edit rate: no posts published in the window, so there is no rate to report.");
    lines.push("This is not a score of 0%. Nothing has been measured yet.");
    return lines.join("\n");
  }

  if (scoreable === 0) {
    lines.push(
      `Zero-edit rate: unmeasurable. ${stats.posted} post(s) published, but none carries a captured`,
      "generated draft to compare against, so there is nothing to score.",
    );
    // The early return used to stop here, which hid the one fact that
    // EXPLAINS the unmeasurability. "Nothing to score" and "everything we
    // posted came from the fallback" are very different reports, and the
    // second is the one that would make the owner act.
    lines.push(...residualLines(stats));
    return lines.join("\n");
  }

  lines.push(
    `Zero-edit rate: ${pct(stats.rate ?? 0)} — ${stats.unedited} of ${scoreable} published post(s) went out exactly as generated.`,
  );
  if (scoreable < 5) {
    lines.push(`Small sample: ${scoreable} post(s). Treat the number as a direction, not a measurement.`);
  }
  lines.push(...residualLines(stats));
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
  const { current, prior } = await northStarStats(env.DB, now, DIGEST_WINDOW_DAYS);
  const efd = await efdLatency(env.DB, since);
  const text = renderDigest(
    stats,
    pairs,
    DIGEST_WINDOW_DAYS,
    // Per-lane rates ride WITH the north star, in the same block, for the
    // same reason it does: they are most informative exactly when the
    // headline numbers are zero, so they must clear renderDigest's early
    // returns too.
    [
      ...renderNorthStar(current, prior, DIGEST_WINDOW_DAYS),
      ...renderLaneRates(await laneRates(env.DB, since.toISOString(), now.toISOString())),
      // Generation health rides in the same block for the same reason (B-08.6):
      // a lane that cards without generating publishes nothing, and that is
      // most worth saying in exactly the weeks the headline numbers are zero.
      ...renderGenHealth(await genHealth(env.DB, since.toISOString(), now.toISOString())),
    ],
    renderEfdLatency(efd, DIGEST_WINDOW_DAYS),
  );
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  } catch (e) {
    // A failed digest must not retry-storm or mark the job failed: it is a
    // report, not a pipeline stage, and the next one carries the same window.
    log("warn", "voice digest send failed", { error: String(e) });
  }
}
