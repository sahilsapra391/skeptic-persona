import type { Env } from "./env";
import { newTickBudget, type TickBudget } from "./lib/budget";
import { CRITICAL_PRIORITY } from "./dispatch";
import { iso } from "./lib/time";
import { log } from "./lib/log";

// SOURCE HEALTH: quarantine endpoints that cannot answer, and probe them back.
//
// WHY THIS KEYS OFF source_state AND NOT jobs. The dispatcher increments
// jobs.consecutive_failures only when a handler THROWS, but every polling
// ingester catches its own fetch error, records it to source_state, and
// returns normally. Measured in production 2026-08-01:
//
//   name                    job_fails  src_fails  src_last_ok
//   treasury_auction                0         16  never
//   press_cftc_enforcement          0          6  never
//   rate_boe                        0          5  2026-08-01
//   senate_ptr                      0          4  2026-07-28
//
// Every job-level counter reads zero. A health check built on the jobs table
// would have reported the fleet perfectly healthy while two sources had never
// once succeeded.
//
// WHAT IT BUYS. treasury_auction and press_cftc_enforcement fail from Worker
// egress by TLS 525 and 403 respectively and always will; both are covered by
// the GitHub Actions relay instead. Until quarantined they spend a subrequest
// and a slice of the tick's time budget on every poll, against endpoints that
// have never answered. The tick is already over budget (68s observed against
// 45s), so this is capacity, not just tidiness.

/** Consecutive source-level failures before a source is considered dead. */
export const QUARANTINE_AFTER = 12;

/**
 * ...and it must also have been silent this long. Both conditions, because a
 * streak alone is not evidence of death: rate_boe carries a failure streak
 * most mornings from overnight UK maintenance and answers again by midday.
 * Quarantining that would silence a working source.
 */
export const QUARANTINE_MIN_SILENCE_HOURS = 12;

/** A quarantined source gets one real attempt again after this long. */
export const PROBE_AFTER_HOURS = 6;

export const SOURCE = "source_health";

// A NOTE ON jobs.last_ok_at, WHICH LIES.
//
// The dispatcher stamps it whenever a handler returns without throwing. Every
// polling ingester catches its own fetch error and returns normally, so the
// stamp records "the handler ran", not "the source answered". Measured in
// production 2026-08-01:
//
//   treasury_auction   jobs.last_ok_at = 2026-08-01   source_state.last_ok_at = never
//                      jobs.consecutive_failures = 0  source_state.consecutive_failures = 16
//
// It does not merely fail to record the failure; it asserts a success today
// for a source that has never once answered. Across all 39 enabled jobs the
// job-level failure total is zero. Nothing here reads jobs.last_ok_at for
// source health, and nothing should.

interface Candidate {
  name: string;
  fails: number;
  lastOkAt: string | null;
}

function hoursSince(iso8601: string | null, now: Date): number {
  if (!iso8601) return Number.POSITIVE_INFINITY;
  const t = new Date(iso8601).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 3_600_000;
}

export function shouldQuarantine(c: Candidate, now: Date): boolean {
  if (c.fails < QUARANTINE_AFTER) return false;
  // Never silenced a source that is currently answering.
  return hoursSince(c.lastOkAt, now) >= QUARANTINE_MIN_SILENCE_HOURS;
}

export async function runSourceHealth(
  env: Env,
  now: Date = new Date(),
  _budget: TickBudget = newTickBudget(),
): Promise<void> {
  // --- Quarantine ---------------------------------------------------------
  // CRITICAL_PRIORITY jobs are exempt for the same reason they are exempt
  // from the starvation guard: the poster and the release watchers are the
  // pipeline, and silencing them automatically is never the right call.
  const candidates = await env.DB.prepare(
    `SELECT j.name AS name, s.consecutive_failures AS fails, s.last_ok_at AS lastOkAt
       FROM jobs j JOIN source_state s ON s.source = j.name
      WHERE j.enabled = 1
        AND j.priority > ?1
        AND s.consecutive_failures >= ?2`,
  )
    .bind(CRITICAL_PRIORITY, QUARANTINE_AFTER)
    .all<Candidate>();

  let quarantined = 0;
  for (const c of candidates.results) {
    if (!shouldQuarantine(c, now)) continue;
    const reason = `${c.fails} consecutive failures, last success ${c.lastOkAt ?? "never"}`;
    await env.DB.prepare(
      `UPDATE jobs SET enabled = 0, quarantined_at = ?1, quarantine_reason = ?2 WHERE name = ?3`,
    )
      .bind(iso(now), reason, c.name)
      .run();
    quarantined += 1;
    log("warn", "source quarantined", { source: c.name, fails: c.fails, lastOkAt: c.lastOkAt });
  }

  // --- Recovery probe -----------------------------------------------------
  // Re-enable and let it try for real. If the endpoint is still dead the
  // streak is untouched, so the next health run quarantines it again. That
  // costs one fetch every PROBE_AFTER_HOURS instead of one every tick, and
  // it means an outage heals itself without anyone noticing it happened.
  const probes = await env.DB.prepare(
    `SELECT name, quarantined_at FROM jobs
      WHERE enabled = 0 AND quarantined_at IS NOT NULL`,
  ).all<{ name: string; quarantined_at: string }>();

  let probed = 0;
  for (const p of probes.results) {
    if (hoursSince(p.quarantined_at, now) < PROBE_AFTER_HOURS) continue;
    await env.DB.prepare(
      `UPDATE jobs SET enabled = 1, due_at = ?1, quarantined_at = NULL WHERE name = ?2`,
    )
      .bind(iso(now), p.name)
      .run();
    probed += 1;
    log("info", "quarantined source released for a probe", { source: p.name });
  }

  if (quarantined > 0 || probed > 0) {
    log("info", "source health pass", { quarantined, probed });
  }
}

export interface HealthRow {
  name: string;
  enabled: number;
  fails: number;
  lastOkAt: string | null;
  quarantineReason: string | null;
}

/**
 * Fleet health, worst first. Backs the /health bot command.
 *
 * Three conditions, and the third exists because of a job the first two
 * cannot see. Some jobs have NO source_state row at all -- internal work
 * like queue_expiry, and watchers like bls_watch -- so a source-keyed
 * report is blind to them however broken they are.
 *
 * The third condition is OVERDUE AND NEVER SUCCEEDED, not merely never
 * succeeded: bls_watch is legitimately scheduled three days out against a
 * BLS release window, and flagging a job that simply has not come due yet
 * would be a false alarm in a report whose whole value is that it is quiet
 * when things are fine.
 */
export async function healthReport(env: Env, now: Date = new Date()): Promise<HealthRow[]> {
  const rows = await env.DB.prepare(
    `SELECT j.name AS name, j.enabled AS enabled,
            COALESCE(s.consecutive_failures, 0) AS fails,
            s.last_ok_at AS lastOkAt,
            j.quarantine_reason AS quarantineReason
       FROM jobs j LEFT JOIN source_state s ON s.source = j.name
      WHERE j.enabled = 0
         OR COALESCE(s.consecutive_failures, 0) > 0
         OR (j.last_ok_at IS NULL AND j.due_at <= ?1)
      ORDER BY j.enabled ASC, fails DESC`,
  )
    .bind(iso(now))
    .all<HealthRow>();
  return rows.results;
}

/** Plain text for Telegram. No parse_mode, so nothing here may be escaped. */
export function formatHealth(rows: readonly HealthRow[], now: Date): string {
  if (rows.length === 0) return "All sources healthy: no failures, none quarantined.";
  const lines = rows.map((r) => {
    const state = r.enabled === 0 ? "QUARANTINED" : "failing";
    const since =
      r.lastOkAt === null
        ? "never succeeded"
        : `last ok ${Math.round(hoursSince(r.lastOkAt, now))}h ago`;
    return `${r.name}: ${state}, ${r.fails} fails, ${since}`;
  });
  return `Source health (${rows.length} not clean):\n${lines.join("\n")}`;
}
