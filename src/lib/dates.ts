// p6-02 (A3): ONE date convention, pipeline-wide.
//
// Observed in a single screen of live cards: `2026-08-05`, `08/07/2026`,
// `8/5/2026` and `week ending 2026-08-04`. Three formats, one of them raw ISO,
// flagged as a defect weeks earlier and still shipping. Measured over the
// 61-card window: raw ISO in 23 of 61, slash dates in 10 of 61.
//
// The convention (owner, A3): `August 5, 2026`, and `August 5` when the year
// is the current year and therefore unambiguous in context.
//
// TWO PARSING RULES THAT ARE NOT OPTIONAL:
//
// 1. NEVER `Date.parse` A SLASH DATE. V8 reads `08/07/2026` as LOCAL midnight
//    and the old formatter then read it back with `getUTCMonth`/`getUTCDate`,
//    which is off by one day on any host east of Greenwich. CI and workerd
//    both run UTC, so that bug passes green everywhere it is tested and only
//    shows up in production if the runtime's zone ever moves. The components
//    are parsed directly here instead.
// 2. Feed formats disagree by design. Form 144 files `MM/DD/YYYY`, EDGAR files
//    `YYYY-MM-DD`, our own payloads carry ISO datetimes. All three arrive
//    here; none of them reaches copy.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

/**
 * Parse the three conventions the pipeline actually receives, by COMPONENT.
 * Returns null for anything else rather than guessing — a date we cannot read
 * is omitted, never approximated.
 */
export function parseDateParts(raw: unknown): DateParts | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;

  // ISO date or ISO datetime: take the date half literally. Reading the time
  // half would re-introduce a zone conversion for no benefit — an EDGAR filing
  // date is a calendar fact, not an instant.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(s);
  if (iso) return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // US slash date, as Form 144 and the congressional feeds file it.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return valid(Number(us[3]), Number(us[1]), Number(us[2]));

  return null;
}

/** Reject 02/30 and friends by round-tripping the components. */
function valid(year: number, month: number, day: number): DateParts | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * The one function copy calls.
 *
 * `now` is REQUIRED rather than defaulted to `new Date()`. Whether the year is
 * printed depends on what year it is, so a hidden clock read would make this
 * untestable and would make two calls in the same render disagree across a
 * midnight boundary. Every caller already has a `now`.
 */
export function displayDate(raw: unknown, now: Date): string | null {
  const p = parseDateParts(raw);
  if (p === null) return null;
  const month = MONTHS[p.month - 1]!;
  // The year is dropped ONLY when it is the current one. A 2025 filing read in
  // 2026 always says so, because "August 5" would silently claim this year.
  return p.year === now.getUTCFullYear() ? `${month} ${p.day}` : `${month} ${p.day}, ${p.year}`;
}

/**
 * A date RANGE, for a filing whose transactions span days.
 *
 * `over 2026-08-05–2026-08-06` shipped on card #1244. The month is not
 * repeated when both ends share it, and the year appears at most once.
 */
export function displayDateRange(lo: unknown, hi: unknown, now: Date): string | null {
  const a = parseDateParts(lo);
  const b = parseDateParts(hi);
  if (a === null || b === null) return null;
  if (a.year === b.year && a.month === b.month && a.day === b.day) return displayDate(lo, now);
  const sameYear = a.year === b.year;
  const thisYear = sameYear && a.year === now.getUTCFullYear();
  const left = sameYear && a.month === b.month
    ? `${MONTHS[a.month - 1]!} ${a.day}`
    : `${MONTHS[a.month - 1]!} ${a.day}${sameYear ? "" : `, ${a.year}`}`;
  const right = sameYear && a.month === b.month
    ? `${b.day}`
    : `${MONTHS[b.month - 1]!} ${b.day}`;
  return `${left}–${right}${thisYear ? "" : `, ${b.year}`}`;
}

/**
 * THE GUARD. Any raw machine date reaching copy is a defect, so the shape is
 * named once here and asserted by the render tests rather than re-invented.
 */
export const RAW_DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;

export function containsRawDate(text: string): boolean {
  return RAW_DATE_RE.test(text);
}
