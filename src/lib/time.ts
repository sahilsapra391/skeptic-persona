// Timezone helpers built on Intl (workerd ships full ICU). No dependencies.
// Everything stored/compared as ISO-8601 UTC; zone math happens only here.

export const ET = "America/New_York";
export const IST = "Asia/Kolkata";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 1=Mon ... 7=Sun (ISO)
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl may render midnight as "24" with hour12:false + 2-digit in some engines.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0,
  };
}

export function isWeekday(date: Date, tz: string): boolean {
  return zonedParts(date, tz).weekday <= 5;
}

export function minutesOfDay(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/**
 * True when `date` falls on a weekday within [startMin, endMin) local minutes
 * in `tz`. Holidays are NOT considered here: polling on a market holiday is
 * harmless, and the verified holiday table ships with the session-math work
 * in PR-4 where correctness actually matters.
 */
export function inWeekdayWindow(date: Date, tz: string, startMin: number, endMin: number): boolean {
  if (!isWeekday(date, tz)) return false;
  const m = minutesOfDay(date, tz);
  return m >= startMin && m < endMin;
}

/** UTC offset of `tz` at `date`, in minutes (EDT = -240, EST = -300, IST = +330). */
export function utcOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round to whole minutes to shed sub-second drift from the parts conversion.
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Interpret a wall-clock time in `tz` on a specific calendar date as a UTC
 * instant. DST-correct via two-pass offset resolution; a nonexistent local
 * time (the spring-forward gap) resolves one hour later.
 */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  guess = new Date(guess.getTime() - utcOffsetMinutes(guess, tz) * 60000);
  const local = zonedParts(guess, tz);
  let delta = hour * 60 + minute - (local.hour * 60 + local.minute);
  if (delta > 720) delta -= 1440;
  if (delta < -720) delta += 1440;
  if (delta !== 0) {
    const nudged = new Date(guess.getTime() + delta * 60000);
    const check = zonedParts(nudged, tz);
    if (check.hour === hour && check.minute === minute) guess = nudged;
  }
  return guess;
}

/**
 * Next instant at hh:mm local time in `tz`, strictly after `from`.
 * DST-correct: computes the offset at the candidate instant, not at `from`.
 * A nonexistent local time (the spring-forward gap, e.g. 02:30 on the US
 * transition day) resolves one hour later (03:30 local).
 */
export function nextLocalTime(from: Date, tz: string, hour: number, minute: number, weekdaysOnly = false): Date {
  const start = zonedParts(from, tz);
  for (let addDays = 0; addDays <= 8; addDays++) {
    // Calendar-date arithmetic in a UTC container: a fixed +24h probe can
    // skip a local date entirely on 23-hour spring-forward days.
    const cal = new Date(Date.UTC(start.year, start.month - 1, start.day + addDays, 12));
    const guess = zonedTimeToUtc(tz, cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), hour, minute);
    if (guess.getTime() <= from.getTime()) continue;
    if (weekdaysOnly && !isWeekday(guess, tz)) continue;
    return guess;
  }
  // Unreachable for sane inputs; fall back to +24h.
  return new Date(from.getTime() + 86_400_000);
}

export function iso(date: Date): string {
  return date.toISOString();
}
