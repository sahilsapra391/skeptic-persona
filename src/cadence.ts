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
  | "daily_1330_utc"; // generic daily slot (used by calendar sync jobs)

/** Off-window next-due: now + offMs, clamped so we never sleep past the window open. */
function offWindow(now: Date, offMs: number, openHour: number): Date {
  const off = new Date(now.getTime() + offMs);
  const open = nextLocalTime(now, ET, openHour, 0, true);
  return off.getTime() < open.getTime() ? off : open;
}

export function nextDue(profile: string, now: Date): Date {
  switch (profile as CadenceProfile) {
    case "every_2m_us_0600_2200":
      return inWeekdayWindow(now, ET, 6 * 60, 22 * 60)
        ? new Date(now.getTime() + 2 * MIN)
        : offWindow(now, 10 * MIN, 6);
    case "every_1m_us_0400_2000": {
      if (inWeekdayWindow(now, ET, 4 * 60, 20 * 60)) return new Date(now.getTime() + 1 * MIN);
      return nextLocalTime(now, ET, 4, 0, true);
    }
    case "every_5m_us_0600_2200":
      return inWeekdayWindow(now, ET, 6 * 60, 22 * 60)
        ? new Date(now.getTime() + 5 * MIN)
        : offWindow(now, 30 * MIN, 6);
    case "every_5m":
      return new Date(now.getTime() + 5 * MIN);
    case "every_30m":
      return new Date(now.getTime() + 30 * MIN);
    case "hourly":
      return new Date(now.getTime() + 60 * MIN);
    case "daily_1330_utc": {
      const next = new Date(now.getTime());
      next.setUTCHours(13, 30, 0, 0);
      if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    default:
      // Unknown profile (typo in a seeded migration): park an hour out
      // instead of hot-looping, and say so loudly.
      log("warn", "unknown cadence profile; defaulting to hourly", { profile });
      return new Date(now.getTime() + 60 * MIN);
  }
}
