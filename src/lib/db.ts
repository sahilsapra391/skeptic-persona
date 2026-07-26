import { iso } from "./time";

// Item scores (alert grades).
export const SCORE_IGNORE = 0;
export const SCORE_LOG_ONLY = 1;
export const SCORE_POSTABLE = 2;
export const SCORE_AUTO_ALERT = 3;

export interface NewItem {
  source: string;
  externalId: string;
  category: string;
  eventAt: string | null; // ISO UTC
  sourceUrl: string;
  payload: Record<string, unknown>;
  score: number;
}

export function dedupKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

/**
 * Insert an item, deduplicating on (source, external_id).
 * Dedup lives in D1 by design: KV free tier allows only 1k writes/day,
 * while D1 allows 100k rows written/day (see docs/verification/).
 */
export async function insertItem(
  db: D1Database,
  item: NewItem,
  now: Date = new Date(),
): Promise<{ outcome: "inserted" | "duplicate"; id: number | null }> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO items
         (dedup_key, source, external_id, category, event_at, fetched_at, source_url, payload, score)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      dedupKey(item.source, item.externalId),
      item.source,
      item.externalId,
      item.category,
      item.eventAt,
      iso(now),
      item.sourceUrl,
      JSON.stringify(item.payload),
      item.score,
    )
    .run();
  if (res.meta.changes === 0) return { outcome: "duplicate", id: null };
  return { outcome: "inserted", id: res.meta.last_row_id ?? null };
}

export interface SourceState {
  source: string;
  etag: string | null;
  lastModified: string | null;
  cursor: string | null;
  lastPolledAt: string | null;
  lastOkAt: string | null;
  consecutiveFailures: number;
}

export async function getSourceState(db: D1Database, source: string): Promise<SourceState> {
  const row = await db
    .prepare(`SELECT * FROM source_state WHERE source = ?1`)
    .bind(source)
    .first<Record<string, unknown>>();
  if (!row) {
    return {
      source,
      etag: null,
      lastModified: null,
      cursor: null,
      lastPolledAt: null,
      lastOkAt: null,
      consecutiveFailures: 0,
    };
  }
  return {
    source,
    etag: (row.etag as string | null) ?? null,
    lastModified: (row.last_modified as string | null) ?? null,
    cursor: (row.cursor as string | null) ?? null,
    lastPolledAt: (row.last_polled_at as string | null) ?? null,
    lastOkAt: (row.last_ok_at as string | null) ?? null,
    consecutiveFailures: (row.consecutive_failures as number) ?? 0,
  };
}

export async function putSourceState(db: D1Database, s: SourceState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_state (source, etag, last_modified, cursor, last_polled_at, last_ok_at, consecutive_failures)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(source) DO UPDATE SET
         etag = excluded.etag,
         last_modified = excluded.last_modified,
         cursor = excluded.cursor,
         last_polled_at = excluded.last_polled_at,
         last_ok_at = excluded.last_ok_at,
         consecutive_failures = excluded.consecutive_failures`,
    )
    .bind(s.source, s.etag, s.lastModified, s.cursor, s.lastPolledAt, s.lastOkAt, s.consecutiveFailures)
    .run();
}
