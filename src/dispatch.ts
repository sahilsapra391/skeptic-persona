import type { Env } from "./env";
import { nextDue } from "./cadence";
import { fetchPool, MAX_CONCURRENT_FETCHES, newTickBudget, type TickBudget } from "./lib/budget";
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
export const MAX_JOBS_PER_TICK = 24;

/**
 * Jobs run per tick at once. Conservative on purpose: Workers allows 6
 * simultaneous outbound connections, and several SEC-hosted jobs can be due
 * in the same tick while SEC asks for <= 10 req/s. Raise it from [vars] after
 * measuring, not before — the tick time budget is the safety net either way.
 */
export const TICK_JOB_CONCURRENCY = 3;

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

/**
 * How far past its due time a job must fall before it pre-empts higher
 * priority work. Long enough that a busy minute does not reorder the tick,
 * short enough that an hourly job never misses two slots in a row.
 */
export const STARVATION_MS = 30 * 60_000;

/**
 * Priorities that a starving job may NEVER pre-empt.
 *
 * The poster (0) and the BLS watchers (10) are latency-critical: a release
 * watcher due exactly at T is worthless a minute late, and the poster must
 * never queue behind feed polls. A starving job jumps its PEERS, not these.
 */
export const CRITICAL_PRIORITY = 10;

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
  //
  // STARVATION GUARD (first sort key). Priority alone is not enough, because
  // the tick has a TIME budget as well as a count limit: when the loop breaks
  // early it always breaks at the same place, so anything below the cut never
  // runs again. Observed in production 2026-07-28 -- every tick logged
  // "ranThisTick: 1..4, deferred: 5", and issuer_refresh (priority 90) and
  // fda_food_recall (55) had NEVER run, while priority-50 jobs due every
  // minute cycled forever ahead of them.
  //
  // A job overdue by more than STARVATION_MS therefore jumps the queue,
  // but never ahead of CRITICAL_PRIORITY work: a starving ingester must not
  // delay the poster or a release watcher, which are worthless late.
  // Normal operation is unchanged: nothing is
  // starving, so the flag is 0 for everything and this reduces to the
  // priority ordering above.
  const starvingBefore = iso(new Date(now.getTime() - STARVATION_MS));
  const due = await env.DB.prepare(
    `SELECT name, cadence_profile, due_at, priority FROM jobs
     WHERE enabled = 1 AND due_at <= ?1
     ORDER BY CASE
                WHEN priority <= ?4 THEN 0
                WHEN due_at <= ?3 THEN 1
                ELSE 2
              END, priority, due_at
     LIMIT ?2`,
  )
    .bind(iso(now), MAX_JOBS_PER_TICK, starvingBefore, CRITICAL_PRIORITY)
    .all<JobRow>();

  // One EXTERNAL-fetch budget shared by every job this tick (50/invocation
  // platform cap; D1/KV are a separate 1,000 budget). Handlers defer work
  // they can't afford to the next tick.
  const budget = newTickBudget();
  const startedAt = performance.now();
  const timeBudgetMs = Number(env.TICK_TIME_BUDGET_MS ?? TICK_TIME_BUDGET_MS) || TICK_TIME_BUDGET_MS;

  // CONCURRENT, not serial. Jobs are almost entirely network wait — a feed
  // poll is one request and a few hundred ms of latency — and running them
  // one after another made tick time the SUM of those waits. Measured in
  // production 2026-07-28: 4 jobs, 68.6 seconds, against a 45s budget and a
  // 60s cron interval, so ~36 of 40 jobs were deferred every tick and the
  // slowest were effectively starved. That is a latency problem before it is
  // a throughput one: a source polled "every 2 minutes" was running every
  // ten, which is the opposite of being first to a filing.
  //
  // Concurrency is bounded and deliberately conservative. Workers allows 6
  // simultaneous outbound connections on both plans (see lib/budget.ts), and
  // several SEC-hosted jobs can be due together while SEC asks for <= 10
  // req/s, so the default leaves headroom rather than saturating the ceiling.
  // Per-source pacing inside each ingester still applies underneath this.
  const rawConcurrency = Number(env.TICK_JOB_CONCURRENCY ?? TICK_JOB_CONCURRENCY);
  const concurrency =
    Number.isFinite(rawConcurrency) && rawConcurrency >= 1 && rawConcurrency <= MAX_CONCURRENT_FETCHES
      ? Math.floor(rawConcurrency)
      : TICK_JOB_CONCURRENCY;

  let ran = 0;
  let deferred = 0;
  await fetchPool(
    due.results,
    async (row: JobRow) => {
      // Don't START a job we probably can't finish: a killed invocation leaves
      // partial state (a claimed-but-unpublished post, a half-written ledger).
      // Checked per item at dispatch time, so a slow first wave still stops
      // the second from starting. `ran > 0` keeps the first job unconditional,
      // or nothing would ever make progress on a slow tick.
      if (ran > 0 && elapsedMs(startedAt) >= timeBudgetMs) {
        deferred += 1;
        return;
      }
      // Atomic claim + reschedule BEFORE running. The compare-and-set on the
      // observed due_at means overlapping cron invocations (Cloudflare does
      // not serialize them; a stalled tick can outlive the next cron fire)
      // cannot double-run a job, and a crashing handler doesn't retry every
      // minute against a source (politeness beats at-least-once; ingesters
      // are idempotent via dedup anyway). Concurrency does not weaken this:
      // the CAS is a single D1 statement and the loser sees changes === 0.
      const claim = await env.DB.prepare(`UPDATE jobs SET due_at = ?1 WHERE name = ?2 AND due_at = ?3`)
        .bind(iso(nextDue(row.cadence_profile, now)), row.name, row.due_at)
        .run();
      if (claim.meta.changes === 0) return; // another invocation owns it

      const handler = registry[row.name];
      if (!handler) {
        log("warn", "no handler registered for job", { job: row.name });
        return;
      }
      ran += 1;
      try {
        await handler(env, now, budget);
        // .catch: a D1 hiccup on BOOKKEEPING must not be logged as the job
        // failing — that would invert the very signal this column exists for.
        await env.DB.prepare(`UPDATE jobs SET last_ok_at = ?1, consecutive_failures = 0 WHERE name = ?2`)
          .bind(iso(now), row.name)
          .run()
          .catch(() => {});
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
    },
    concurrency,
  );

  if (deferred > 0) {
    log("warn", "tick time budget spent; deferring remaining jobs to the next tick", {
      ranThisTick: ran,
      deferred,
      elapsedMs: Math.round(elapsedMs(startedAt)),
      concurrency,
    });
  }
}
