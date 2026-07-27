import type { Env } from "./env";
import { nextDue } from "./cadence";
import { newTickBudget, type TickBudget } from "./lib/budget";
import { iso } from "./lib/time";
import { log } from "./lib/log";

// The whole pipeline runs behind ONE cron trigger ("* * * * *"): the free
// plan allows 5 cron expressions per ACCOUNT, so schedules live in the D1
// jobs table and this dispatcher fans out to due jobs each minute.

/**
 * Jobs started per tick. Raised 4 -> 12 for the paid tier and the source
 * expansion: at ~40 jobs, four per tick means a fully-due backlog takes ten
 * minutes to drain, which silently defeats the release-second watchers that
 * are the entire point of the scheduled-print archetype. TICK_TIME_BUDGET_MS
 * remains the real governor.
 */
export const MAX_JOBS_PER_TICK = 12;

/**
 * Per-tick TIME budget (wall clock, not CPU — performance.now() measures
 * elapsed time, and a tick's wall time runs ~500x its CPU time because these
 * jobs are fetch-bound: production ticks showed wallTime 4982 ms against
 * cpuTime 10 ms).
 *
 * Why it exists: Cloudflare kills an over-budget invocation MID-JOB, which is
 * how a poster claim got stranded on 2026-07-27 (CPU ceiling on the free
 * plan). We're on Workers Paid now — 30 s CPU and 15 min wall for crons — so
 * this is a backstop against pathological ticks, not a routine limiter. It
 * must stay well under the wall ceiling while never deferring normal work.
 *
 * A deferred job runs next minute; a job killed halfway leaves partial state.
 */
export const TICK_TIME_BUDGET_MS = 45_000;

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

export type JobHandler = (env: Env, now: Date, budget: TickBudget) => Promise<void>;

// Ingester PRs register handlers here and seed their jobs row in a migration.
export const registry: Record<string, JobHandler> = {};

export const KILL_SWITCH_KEY = "kill_switch";

interface JobRow {
  name: string;
  cadence_profile: string;
  due_at: string;
  priority: number;
}

export async function tick(env: Env, now: Date = new Date()): Promise<void> {
  if ((await env.KV.get(KILL_SWITCH_KEY)) === "1") {
    log("warn", "kill switch active; skipping tick");
    return;
  }

  // ORDER BY priority THEN due_at: a watcher due exactly at T must pre-empt
  // stale ingester backlog, and the poster (priority 0) must never queue
  // behind 40 feed polls. Pure due_at ordering cannot express that.
  const due = await env.DB.prepare(
    `SELECT name, cadence_profile, due_at, priority FROM jobs
     WHERE enabled = 1 AND due_at <= ?1
     ORDER BY priority, due_at
     LIMIT ?2`,
  )
    .bind(iso(now), MAX_JOBS_PER_TICK)
    .all<JobRow>();

  // One EXTERNAL-fetch budget shared by every job this tick (50/invocation
  // platform cap; D1/KV are a separate 1,000 budget). Handlers defer work
  // they can't afford to the next tick.
  const budget = newTickBudget();
  const startedAt = performance.now();
  const timeBudgetMs = Number(env.TICK_TIME_BUDGET_MS ?? TICK_TIME_BUDGET_MS) || TICK_TIME_BUDGET_MS;

  let ran = 0;
  for (const row of due.results) {
    // Don't START a job we probably can't finish: a killed invocation leaves
    // partial state (a claimed-but-unpublished post, a half-written ledger).
    // The first job always runs, or nothing would ever make progress.
    if (ran > 0 && elapsedMs(startedAt) >= timeBudgetMs) {
      log("warn", "tick time budget spent; deferring remaining jobs to the next tick", {
        ranThisTick: ran,
        deferred: due.results.length - ran,
        elapsedMs: Math.round(elapsedMs(startedAt)),
      });
      break;
    }
    // Atomic claim + reschedule BEFORE running. The compare-and-set on the
    // observed due_at means overlapping cron invocations (Cloudflare does
    // not serialize them; a stalled tick can outlive the next cron fire)
    // cannot double-run a job, and a crashing handler doesn't retry every
    // minute against a source (politeness beats at-least-once; ingesters
    // are idempotent via dedup anyway).
    const claim = await env.DB.prepare(`UPDATE jobs SET due_at = ?1 WHERE name = ?2 AND due_at = ?3`)
      .bind(iso(nextDue(row.cadence_profile, now)), row.name, row.due_at)
      .run();
    if (claim.meta.changes === 0) continue; // another invocation owns it

    const handler = registry[row.name];
    if (!handler) {
      log("warn", "no handler registered for job", { job: row.name });
      continue;
    }
    try {
      await handler(env, now, budget);
      await env.DB.prepare(
        `UPDATE jobs SET last_ok_at = ?1, consecutive_failures = 0 WHERE name = ?2`,
      )
        .bind(iso(now), row.name)
        .run();
    } catch (e) {
      log("error", "job failed", { job: row.name, error: String(e) });
      // Job-level health: source_state tracks whether a SOURCE answers;
      // this tracks whether the JOB itself completes, so a handler that
      // throws before ever touching the network is still visible.
      await env.DB.prepare(
        `UPDATE jobs SET consecutive_failures = consecutive_failures + 1 WHERE name = ?1`,
      )
        .bind(row.name)
        .run()
        .catch(() => {});
    }
    ran += 1;
  }
}
