/**
 * Shared per-tick budget for EXTERNAL fetches. The dispatcher creates one per
 * tick and passes it to every job handler, so per-job caps compose instead of
 * summing past the limit. A handler that can't take() defers to the next tick.
 *
 * PAID TIER (verified 2026-07-27): subrequests are 10,000 per invocation, so
 * the platform cap is no longer what this protects. Its job now is to bound
 * blast radius and stay polite to sources (SEC asks <=10 req/s; openFDA
 * quotas are per-IP and Cloudflare egress IPs are SHARED).
 *
 * The real ceiling is CONCURRENCY: 6 simultaneous outbound connections, on
 * BOTH plans, unchanged. A job firing 20 fetches serializes them 6 at a time,
 * so wall time is what a tick actually runs out of — see fetchPool().
 */
export interface TickBudget {
  /**
   * Reserve n external fetches; false (and nothing reserved) if not enough
   * left. Pass {reserved: true} for priority work (the poster) to draw on the
   * reserve that ingesters cannot touch.
   */
  take(n?: number, opts?: { reserved?: boolean }): boolean;
  remaining(opts?: { reserved?: boolean }): number;
}

/** Paid tier: politeness/blast-radius bound, not a platform cap. */
export const TICK_EXTERNAL_BUDGET = 200;

/**
 * Fetches held back for priority work. A heavy ingester (13D/G on a busy day
 * is 40 feed entries x 1 document fetch each) must not be able to spend the
 * tick down to zero and leave the poster unable to publish an approved draft.
 * Only takers passing {reserved: true} may draw below this line.
 */
export const TICK_RESERVED_FETCHES = 20;

export function newTickBudget(
  limit: number = TICK_EXTERNAL_BUDGET,
  reserved: number = TICK_RESERVED_FETCHES,
): TickBudget {
  let left = limit;
  // Scale the reserve to the limit: a flat 20 would swallow a small budget
  // whole (newTickBudget(1) would reserve its only fetch and nothing could
  // run at all). Ten percent keeps the reserve meaningful at 200 and
  // harmless below it.
  const floor = Math.min(reserved, Math.floor(limit / 10));
  return {
    take(n = 1, opts): boolean {
      const available = opts?.reserved ? left : left - floor;
      if (n > available) return false;
      left -= n;
      return true;
    },
    remaining(opts?: { reserved?: boolean }): number {
      return opts?.reserved ? left : Math.max(0, left - floor);
    },
  };
}

/**
 * Run tasks with bounded concurrency. The platform allows only 6 simultaneous
 * outbound connections (both plans), so firing 40 fetches at once does not go
 * faster — it just queues inside the runtime where we cannot see it. Batching
 * here keeps wall time predictable and keeps us polite to the source.
 */
export const MAX_CONCURRENT_FETCHES = 6;

/**
 * Inner-pool width for the SEC-hosted fan-out ingesters (13D/G, Form 144,
 * Form 25). These pools nest INSIDE the dispatcher's job pool, and concurrency
 * multiplies: three SEC jobs running together, each opening its own default
 * 6-wide pool, is 18 simultaneous connections to www.sec.gov against a source
 * that asks for <= 10 req/s.
 *
 * It is not a hypothetical overlap. All three carry cadence
 * `every_5m_us_0600_2200` and priority 50 (migrations 0012/0021/0035), so they
 * sort adjacently under the dispatcher's `ORDER BY ... priority, due_at` and
 * land in the same wave by construction, not by chance.
 *
 * The invariant is the PRODUCT, pinned by a test in test/dispatch.test.ts:
 *   MAX_TICK_JOB_CONCURRENCY (3) * SEC_POOL_CONCURRENCY (2) <= MAX_CONCURRENT_FETCHES (6)
 * Raising either constant without the other going down turns that test red.
 */
export const SEC_POOL_CONCURRENCY = 2;

export interface PoolResult<R> {
  /** Per item, by index: the worker's value, or undefined if it threw. */
  results: Array<R | undefined>;
  errors: Array<{ index: number; error: unknown }>;
}

/**
 * `concurrency` is REQUIRED, deliberately. It defaulted to
 * MAX_CONCURRENT_FETCHES, and three SEC-hosted ingesters silently took that
 * default while nesting inside the dispatcher's own pool — 18 simultaneous
 * connections to one host that nothing in the code stated and no test could
 * see. A required argument makes the omission a type error instead of a
 * number you have to go looking for. Pass MAX_CONCURRENT_FETCHES explicitly
 * for a top-level pool; pass a narrower width for anything nested.
 */
export async function fetchPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<PoolResult<R>> {
  const results: Array<R | undefined> = new Array(items.length);
  const errors: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  // Each item is independent (one filing, one fetch), so ONE failure must not
  // void the batch: a rejecting Promise.all would discard results already
  // computed, abandon undispatched items, and leave in-flight runners
  // unawaited — where a second rejection becomes an unhandled rejection.
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]!, i);
      } catch (error) {
        errors.push({ index: i, error });
      }
    }
  });
  await Promise.all(runners);
  return { results, errors };
}
