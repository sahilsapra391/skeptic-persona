import type { Env } from "./env";
import { nextDue } from "./cadence";
import { newTickBudget, type TickBudget } from "./lib/budget";
import { iso } from "./lib/time";
import { log } from "./lib/log";

// The whole pipeline runs behind ONE cron trigger ("* * * * *"): the free
// plan allows 5 cron expressions per ACCOUNT, so schedules live in the D1
// jobs table and this dispatcher fans out to due jobs each minute.

/** Cap per tick keeps a single invocation well inside the 10 ms CPU / 50
 * subrequest free-tier budget; anything left over runs next minute. */
export const MAX_JOBS_PER_TICK = 4;

export type JobHandler = (env: Env, now: Date, budget: TickBudget) => Promise<void>;

// Ingester PRs register handlers here and seed their jobs row in a migration.
export const registry: Record<string, JobHandler> = {};

export const KILL_SWITCH_KEY = "kill_switch";

interface JobRow {
  name: string;
  cadence_profile: string;
  due_at: string;
}

export async function tick(env: Env, now: Date = new Date()): Promise<void> {
  if ((await env.KV.get(KILL_SWITCH_KEY)) === "1") {
    log("warn", "kill switch active; skipping tick");
    return;
  }

  const due = await env.DB.prepare(
    `SELECT name, cadence_profile, due_at FROM jobs
     WHERE enabled = 1 AND due_at <= ?1
     ORDER BY due_at
     LIMIT ?2`,
  )
    .bind(iso(now), MAX_JOBS_PER_TICK)
    .all<JobRow>();

  // One EXTERNAL-fetch budget shared by every job this tick (50/invocation
  // platform cap; D1/KV are a separate 1,000 budget). Handlers defer work
  // they can't afford to the next tick.
  const budget = newTickBudget();

  for (const row of due.results) {
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
    } catch (e) {
      log("error", "job failed", { job: row.name, error: String(e) });
    }
  }
}
