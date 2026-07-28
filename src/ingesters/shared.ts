/**
 * Stale-at-ingest cutoff shared by all ingesters. A wire is only worth
 * notifying about while it is news: anything older than this at FIRST SIGHT
 * (first-deploy backfill, outage recovery, overflow catch-ups) goes to the
 * data lake as 'logged' instead of spamming the approval queue.
 */
export const STALE_AT_INGEST_HOURS = 24;

export function isFreshAtIngest(eventIso: string, now: Date): boolean {
  if (!eventIso) return false; // no parsed timestamp -> can't claim freshness
  const age = now.getTime() - new Date(eventIso).getTime();
  return age <= STALE_AT_INGEST_HOURS * 3_600_000;
}

/**
 * Freshness for DATE-ONLY sources (congressional filings carry no
 * time-of-day). Anchoring a date at UTC midnight and applying the 24h gate
 * would expire filings at ~20:00 ET of their own filing day — evening
 * disclosures would silently self-suppress. Date-only precision gets a
 * whole-day allowance instead: fresh through 48h after the UTC-midnight
 * anchor (i.e. the filing date and the day after).
 */
export function isFreshDateOnly(dateOnlyIso: string, now: Date): boolean {
  if (!dateOnlyIso) return false;
  const age = now.getTime() - new Date(dateOnlyIso).getTime();
  return age <= 2 * STALE_AT_INGEST_HOURS * 3_600_000;
}

/** Compact money formatting for drafts ($950, $617K, $1.2M) — display of parsed numbers. */
export function fmtUsd(n: number): string {
  // Billions tier: Treasury auctions run to tens of billions, and without
  // this a $69B offering rendered as "$69000M".
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Days between a filing date and a transaction date, both date-only.
 * Lives here because BOTH chambers need it and the disclosure lag is the
 * editorial point of a PTR post — two implementations would eventually
 * disagree about how late a trade was reported.
 */
/**
 * MM/DD/YYYY (date-only, as both chambers serve it) -> ISO at UTC midnight.
 *
 * Digits are NOT zero-padded by either source: the House bulk index serves
 * "2/11/2026" and "7/8/2026" today. This is the ONE date parser for
 * congressional filings; efdDateToIso and houseDateToIso delegate here.
 * A stricter copy of this regex silently returned null and dropped the whole
 * disclosure-lag clause, which is a parsed fact going unstated.
 */
export function mdyToIso(mdY: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdY.trim());
  if (!m) return "";
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}T00:00:00.000Z`;
}

export function lagDays(filedIso: string, txnDate: string): number | null {
  const txnIso = mdyToIso(txnDate);
  if (!filedIso || !txnIso) return null;
  const diff = new Date(filedIso).getTime() - new Date(txnIso).getTime();
  if (!Number.isFinite(diff)) return null;
  const days = Math.round(diff / 86_400_000);
  // A disclosure cannot precede its own trade. A future-dated transaction
  // (typo, pre-report) must not print "disclosed -4 days after the latest
  // trade", and must not win the "newest" slot that drives tradeDate,
  // amountBand and the band-width beats. This clamp was lost when the
  // function moved here from senatePtr; form4.ts still enforces it.
  return days >= 0 ? days : null;
}

/**
 * Ratio between a band's upper and lower bound ("$1,001 - $15,000" -> ~15).
 * Gates the "The range is doing a lot of work." escalation beat: a wide band
 * is a parsed property of the disclosure, not an inference about the trade.
 */
export function bandWidth(band: string): number | null {
  const nums = band.match(/[\d,]+/g);
  if (!nums || nums.length < 2) return null;
  const lo = Number(nums[0]!.replace(/,/g, ""));
  const hi = Number(nums[nums.length - 1]!.replace(/,/g, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return hi - lo;
}

export function bandSpan(band: string): number | null {
  const nums = band.match(/[\d,]+/g);
  if (!nums || nums.length < 2) return null;
  const lo = Number(nums[0]!.replace(/,/g, ""));
  const hi = Number(nums[nums.length - 1]!.replace(/,/g, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return null;
  return Math.round((hi / lo) * 10) / 10;
}
