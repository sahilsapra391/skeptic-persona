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

/** Compact money formatting for drafts ($950, $617K, $1.2M) — display of parsed numbers. */
export function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}
