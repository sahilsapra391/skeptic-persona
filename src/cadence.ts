import { ET, inWeekdayWindow, nextLocalTime } from "./lib/time";
import { log } from "./lib/log";

// Cadence profiles map a (profile, now) pair to the next due instant.
// Profiles are strings stored in the D1 jobs table so ingester PRs can seed
// jobs in migrations without code changes here beyond adding a profile.
// Profile names encode their ET window so nobody has to guess.
//
// Windows these encode (see docs/verification/2026-07-26 record):
// - 06:00-22:00 ET weekdays: the EDGAR filing-acceptance window (as reported
//   in the 2026-07-26 verification run); also used for Fed press polling.
// - 04:00-20:00 ET weekdays: US extended trading hours (halts feed; Nasdaq
//   RSS ttl=1 sanctions 60 s polling).
// - NYSE halts CSV sits behind a 300 s edge cache -> 5 min floor.
//
// Off-window cadences clamp to the next window open so the first minutes of
// a trading day are never covered at the slow rate.

const MIN = 60_000;

export type CadenceProfile =
  | "every_2m_us_0600_2200" // 2 min inside the window, 10 min outside (clamped to open)
  | "every_1m_us_0400_2000" // 1 min inside, parked to the next weekday 04:00 ET outside
  | "every_5m_us_0600_2200" // 5 min inside, 30 min outside (clamped to open)
  | "every_5m"
  | "every_30m"
  | "hourly"
  | "daily_1330_utc" // generic daily slot (used by calendar sync jobs)
  | "daily_2100_et"; // end-of-day roll-up (digest push, after the US close)

/** Off-window next-due: now + offMs, clamped so we never sleep past the window open. */
function offWindow(now: Date, offMs: number, openHour: number): Date {
  const off = new Date(now.getTime() + offMs);
  const open = nextLocalTime(now, ET, openHour, 0, true);
  return off.getTime() < open.getTime() ? off : open;
}

/**
 * Deterministic 32-bit hash (FNV-1a) of a job name.
 *
 * Deliberately NOT Math.random(): a random phase would make nextDue
 * non-deterministic, untestable, and different on every isolate, so the same
 * job would wander instead of holding a slot. A name hash gives each job a
 * fixed phase that is stable across deploys and reproducible in a test.
 */
function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Interval reschedule with a per-job PHASE, so same-cadence jobs stop running
 * in lockstep.
 *
 * THE DEFECT: nextDue was called with the tick's single shared `now`, so any
 * two jobs of the same cadence that ran in one tick rescheduled to a
 * byte-identical due_at — and stayed phase-locked forever after. That is why
 * sec_form144, sec_schedule13 and sec_form25 (all every_5m_us_0600_2200,
 * all priority 50) land in the same wave "by construction, not by luck", which
 * is exactly what made the nested-pool connection count 3x rather than 1x.
 * Raising MAX_JOBS_PER_TICK made the herd bigger, not smaller.
 *
 * PHASE, NOT JITTER. Adding a few seconds each time would slow every job by
 * the jitter (a 1-minute job polling every 1m05s is a permanent 8% loss) and
 * would let jobs drift back into convergence at different rates. Snapping to
 * `grid + phase` instead gives each job a stable offset inside the interval
 * and an average interval of EXACTLY the interval. Once a job is on its
 * phase, every later reschedule is exact.
 *
 * THE TRANSITION IS BOUNDED IN BOTH DIRECTIONS, at [interval/2, 1.5*interval).
 * The obvious "next grid point after now" gives a gap in (0, interval], which
 * sounds strictly safer and is not: a job whose phase sits just past `now`
 * gets rescheduled milliseconds out and polls again on the very next tick. Do
 * that to ~55 jobs on one deploy and the change intended to REDUCE herding
 * opens with a thundering herd of double-polls against SEC. Requiring at least
 * half an interval costs a one-time delay of up to half an interval on the
 * other side, which no cadence in this repo is tight enough to care about.
 * After the first hop every reschedule is exact.
 *
 * Applied to the interval cadences only. The off-window branches clamp to the
 * window open on purpose — "the first minutes of a trading day are never
 * covered at the slow rate" — and the daily profiles are wall-clock slots
 * where alignment is the point. NOTE the consequence honestly rather than
 * implying this fixes everything: every off-window job still converges on
 * 06:00 ET, so window open remains a herd point this does not address.
 */
function phased(now: Date, intervalMs: number, key: string | undefined): Date {
  const t = now.getTime();
  if (!key) return new Date(t + intervalMs);
  const phase = hashKey(key) % intervalMs;
  // The first grid point `k * interval + phase` at or after now + interval/2.
  // Grid spacing is one interval, so a half-interval window is not guaranteed
  // to contain a point — hence the 1.5x upper bound rather than 1x. Both ends
  // are one-time; once a job sits on its phase, k advances by exactly one and
  // the gap is exactly `interval` forever.
  const earliest = t + intervalMs / 2;
  const k = Math.ceil((earliest - phase) / intervalMs);
  return new Date(k * intervalMs + phase);
}

/**
 * @param key Job name. Optional for callers that only want the profile's
 *        shape (tests, tooling). The dispatcher always passes it — without it
 *        every job of a cadence shares one due_at and the herd re-forms.
 */
export function nextDue(profile: string, now: Date, key?: string): Date {
  switch (profile as CadenceProfile) {
    case "every_2m_us_0600_2200":
      return inWeekdayWindow(now, ET, 6 * 60, 22 * 60)
        ? phased(now, 2 * MIN, key)
        : offWindow(now, 10 * MIN, 6);
    case "every_1m_us_0400_2000": {
      if (inWeekdayWindow(now, ET, 4 * 60, 20 * 60)) return phased(now, 1 * MIN, key);
      return nextLocalTime(now, ET, 4, 0, true);
    }
    case "every_5m_us_0600_2200":
      return inWeekdayWindow(now, ET, 6 * 60, 22 * 60)
        ? phased(now, 5 * MIN, key)
        : offWindow(now, 30 * MIN, 6);
    case "every_5m":
      return phased(now, 5 * MIN, key);
    case "every_30m":
      return phased(now, 30 * MIN, key);
    case "hourly":
      return phased(now, 60 * MIN, key);
    case "daily_1330_utc": {
      const next = new Date(now.getTime());
      next.setUTCHours(13, 30, 0, 0);
      if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    // 21:00 ET: after the US close and after the post-close EDGAR wave (the
    // 20:00-21:00 UTC hour holds 24% of all cards), so a day's digest is
    // complete when it sends. ET-anchored, so it does not drift by an hour
    // across DST the way a fixed UTC slot would.
    case "daily_2100_et":
      return nextLocalTime(now, ET, 21, 0, true);
    default:
      // Unknown profile (typo in a seeded migration): park an hour out
      // instead of hot-looping, and say so loudly.
      log("warn", "unknown cadence profile; defaulting to hourly", { profile });
      return new Date(now.getTime() + 60 * MIN);
  }
}
