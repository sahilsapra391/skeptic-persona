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
