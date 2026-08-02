import type { Env } from "./env";
import { nextDue } from "./cadence";
import { fetchPool, newTickBudget, type TickBudget } from "./lib/budget";
import { iso } from "./lib/time";
import { log } from "./lib/log";

// The whole pipeline runs behind ONE cron trigger ("* * * * *"): the free
// plan allows 5 cron expressions per ACCOUNT, so schedules live in the D1
// jobs table and this dispatcher fans out to due jobs each minute.

/**
 * Jobs started per tick. Raised 4 -> 24 for the paid tier and the source
 * expansion: at ~40 jobs, four per tick means a fully-due backlog takes ten
 * minutes to drain, which silently defeats the release-second watchers that
 * are the entire point of the scheduled-print archetype. TICK_TIME_BUDGET_MS
 * remains the real governor.
 *
 * Raising this can silently disarm a test: the starvation-guard regression in
 * test/dispatch.test.ts only exercises the guard when the fixture is LARGER
 * than this limit, since below it every seeded job runs whatever the ordering.
 * That test now seeds MAX_JOBS_PER_TICK + 1 so it tracks this constant.
 */
export const MAX_JOBS_PER_TICK = 24;

/**
 * Jobs run per tick at once. Conservative on purpose: Workers allows 6
 * simultaneous outbound connections, and several SEC-hosted jobs can be due
 * in the same tick while SEC asks for <= 10 req/s. Raise it from [vars] after
 * measuring, not before — the tick time budget is the safety net either way.
 *
 * This counts JOBS, not connections. A job may open its own inner pool, so the
 * connection count is this number times that pool's width — see
 * SEC_POOL_CONCURRENCY, and MAX_TICK_JOB_CONCURRENCY below for the ceiling.
 */
export const TICK_JOB_CONCURRENCY = 3;

/**
 * Ceiling for the TICK_JOB_CONCURRENCY override from [vars].
 *
 * Separate from MAX_CONCURRENT_FETCHES on purpose. The two were conflated
 * here, and clamping a JOB count against a CONNECTION constant is how 6 came
 * to mean two different things in the same file: it let the override reach 6
 * jobs, each of which could open a 6-wide inner pool. Jobs and connections are
 * different units and now have different constants.
 */
export const MAX_TICK_JOB_CONCURRENCY = 3;

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
  // 60s cron interval — so the tick blew its budget on four jobs and the rest
  // waited for a later minute that kept arriving in the same state.
  //
  // An earlier draft of this comment said "~36 of 40 jobs were deferred every
  // tick". That number is wrong and the correction matters more than the
  // deletion: `deferred` counts only rows the pool actually reached and
  // skipped, so it is bounded by due.results.length - ran, and the LIMIT was
  // 12 at the time. Eight was the arithmetic maximum; five was observed. The
  // starvation was real and independently proven — issuer_refresh (priority
  // 90) and fda_food_recall (55) had never run once — but it was proven by
  // those never-run jobs, not by a deferred count that could not have said it.
  //
  // It is a latency problem before it is a throughput one: a source polled
  // "every 2 minutes" was running every ten, the opposite of being first to a
  // filing.
  //
  // Concurrency is bounded and deliberately conservative. Workers allows 6
  // simultaneous outbound connections on both plans (see lib/budget.ts), and
  // several SEC-hosted jobs can be due together while SEC asks for <= 10
  // req/s, so the default leaves headroom rather than saturating the ceiling.
  //
  // What bounds the CONNECTION count is the product, not this number. Jobs
  // that fan out open their own inner pool, so three SEC jobs at an unbounded
  // inner default would be 18 connections to one host. The inner pools are
  // pinned to SEC_POOL_CONCURRENCY and the product is asserted in the tests.
  //
  // An earlier version of this comment claimed "per-source pacing inside each
  // ingester still applies underneath this." That was false and is worth
  // recording rather than deleting: there is no pacing anywhere. politeFetch
  // sets a User-Agent and conditional-GET headers and calls fetch, with no
  // delay and no token bucket. The only sleeps in those ingesters are
  // QUEUE_NOTIFY_SPACING_MS, which paces TELEGRAM messages (<= 1/s per chat),
  // a different concern that happens to look like the same one.
  const rawConcurrency = Number(env.TICK_JOB_CONCURRENCY ?? TICK_JOB_CONCURRENCY);
  const concurrency =
    Number.isFinite(rawConcurrency) && rawConcurrency >= 1 && rawConcurrency <= MAX_TICK_JOB_CONCURRENCY
      ? Math.floor(rawConcurrency)
      : TICK_JOB_CONCURRENCY;

  let ran = 0;
  let deferred = 0;
  const durations: Array<{ job: string; ms: number }> = [];
  const pool = await fetchPool(
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
      const jobStartedAt = performance.now();
      try {
        await handler(env, now, budget);
        // .catch: a D1 hiccup on BOOKKEEPING must not be logged as the job
        // failing — that would invert the very signal this column exists for.
        await env.DB.prepare(`UPDATE jobs SET last_ok_at = ?1, consecutive_failures = 0 WHERE name = ?2`)
          .bind(iso(now), row.name)
          .run()
          .catch(() => {});
        // Per-job duration. Without it the only capacity evidence this
        // project has is one line from one log ("4 jobs, 68.6s"), which is an
        // average over an unnamed mix — edgar_8k fans out to ten enqueues
        // while halts_nasdaq is one small fetch. The discovery mesh has to be
        // sized against a real distribution, so record one.
        durations.push({ job: row.name, ms: Math.round(elapsedMs(jobStartedAt)) });
      } catch (e) {
        durations.push({ job: row.name, ms: Math.round(elapsedMs(jobStartedAt)) });
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

  // fetchPool swallows every worker rejection into `errors` so one bad item
  // cannot void the batch. That is right for the handler body — which has its
  // own try/catch and records failures against consecutive_failures — but it
  // means anything landing HERE came from the code outside that try: the
  // atomic claim UPDATE and the bookkeeping around it. In other words, an
  // entry in `errors` is D1 itself failing, not a job failing.
  //
  // Serially that exception propagated out of tick(), and src/index.ts depends
  // on it: "Awaited directly: the runtime waits on the returned promise for
  // cron events, and failures then land in the dashboard's Past Events."
  // Dropping it would have made a total claim failure invisible — ran stays 0,
  // consecutive_failures is never incremented because the handler catch is
  // never reached, and the `ran > 0` gate below suppresses even the
  // "tick complete" line. A tick that claimed nothing would report nothing.
  //
  // So: log every one, then re-raise. Re-raising AFTER the pool drains is a
  // deliberate difference from the serial version, and the better half of the
  // trade — the jobs that did claim still finish instead of being abandoned
  // mid-flight, and the signal still reaches Past Events.
  for (const { index, error } of pool.errors) {
    log("error", "dispatch failed outside the handler (claim or bookkeeping)", {
      job: due.results[index]?.name ?? `#${index}`,
      error: String(error),
    });
  }

  if (deferred > 0) {
    log("warn", "tick time budget spent; deferring remaining jobs to the next tick", {
      ranThisTick: ran,
      deferred,
      elapsedMs: Math.round(elapsedMs(startedAt)),
      concurrency,
    });
  }
  if (ran > 0) {
    // One line per tick carrying the whole distribution: wall time, how many
    // ran, and the slowest jobs by name. Sorted so the tail is visible, which
    // is the number that decides how much a tier can afford.
    durations.sort((a, b) => b.ms - a.ms);
    log("info", "tick complete", {
      ran,
      deferred,
      concurrency,
      wallMs: Math.round(elapsedMs(startedAt)),
      // NOT "serialMs". Every entry was measured while up to concurrency-1
      // siblings competed for the runtime and the 6-connection ceiling, so
      // summing them does NOT reconstruct what a serial tick would have cost —
      // it is inflated, and inflated in the direction that makes a new source
      // tier look more affordable than it is. Naming it serialMs would have
      // invited exactly that reading, from me, when sizing the mesh.
      summedJobMs: durations.reduce((n, d) => n + d.ms, 0),
      slowest: durations.slice(0, 5),
    });
  }

  // Last, so a partially-failed tick still reports its distribution above
  // before the exception leaves for Past Events.
  if (pool.errors.length > 0) {
    const first = pool.errors[0]!;
    throw new Error(
      `dispatch: ${pool.errors.length} job(s) failed outside the handler; first was ` +
        `${due.results[first.index]?.name ?? `#${first.index}`}: ${String(first.error)}`,
      { cause: first.error },
    );
  }
}
