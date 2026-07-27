/**
 * Shared per-tick budget for EXTERNAL fetches (the free tier allows 50 per
 * invocation; internal D1/KV calls have a separate 1,000 budget). The
 * dispatcher creates one per tick and passes it to every job handler, so
 * per-job caps compose instead of summing past the platform limit. A handler
 * that can't take() simply defers work to the next tick.
 */
export interface TickBudget {
  /** Reserve n external fetches; false (and nothing reserved) if not enough left. */
  take(n?: number): boolean;
  remaining(): number;
}

/** Default leaves ~10 fetches of headroom under the platform's 50. */
export const TICK_EXTERNAL_BUDGET = 40;

export function newTickBudget(limit: number = TICK_EXTERNAL_BUDGET): TickBudget {
  let left = limit;
  return {
    take(n = 1): boolean {
      if (n > left) return false;
      left -= n;
      return true;
    },
    remaining(): number {
      return left;
    },
  };
}
