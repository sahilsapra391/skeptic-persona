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

// ---------------------------------------------------------------------------
// Approval queue state machine (PR-2). All transitions are guarded UPDATEs
// (`WHERE state = 'pending'`) so double-taps and races resolve to exactly one
// decision; meta.changes tells the caller whether their transition won.
// item status mirrors the queue decision so ingesters can query items alone.

export type QueueDecision = "approved" | "rejected";

export interface QueueEntry {
  id: number;
  itemId: number;
  archetype: string;
  draftText: string;
  telegramMessageId: number | null;
  state: string;
  editedText: string | null;
  editPromptMessageId: number | null;
}

export async function createQueueEntry(
  db: D1Database,
  itemId: number,
  archetype: string,
  draftText: string,
  now: Date = new Date(),
): Promise<number> {
  // db.batch = one subrequest + an implicit transaction: the queue row and
  // the items mirror can never diverge on a mid-write failure.
  const [ins] = await db.batch([
    db
      .prepare(`INSERT INTO queue (item_id, archetype, draft_text, created_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(itemId, archetype, draftText, iso(now)),
    db.prepare(`UPDATE items SET status = 'queued' WHERE id = ?1`).bind(itemId),
  ]);
  return ins?.meta.last_row_id ?? 0;
}

export async function getQueueEntry(db: D1Database, id: number): Promise<QueueEntry | null> {
  const row = await db.prepare(`SELECT * FROM queue WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: row.id as number,
    itemId: row.item_id as number,
    archetype: row.archetype as string,
    draftText: row.draft_text as string,
    telegramMessageId: (row.telegram_message_id as number | null) ?? null,
    state: row.state as string,
    editedText: (row.edited_text as string | null) ?? null,
    editPromptMessageId: (row.edit_prompt_message_id as number | null) ?? null,
  };
}

export async function setQueueTelegramMessageId(db: D1Database, id: number, messageId: number): Promise<void> {
  await db.prepare(`UPDATE queue SET telegram_message_id = ?1 WHERE id = ?2`).bind(messageId, id).run();
}

/** Approve or reject; returns false if the entry was already decided (idempotent double-tap). */
export async function decideQueueEntry(
  db: D1Database,
  id: number,
  decision: QueueDecision,
  now: Date = new Date(),
): Promise<boolean> {
  // Atomic batch; the mirror statement re-checks that the queue row actually
  // reached the target state (batch statements run unconditionally) and only
  // upgrades items still 'queued' so it can never stomp later statuses.
  const [flip] = await db.batch([
    db
      .prepare(`UPDATE queue SET state = ?1, decided_at = ?2 WHERE id = ?3 AND state = 'pending'`)
      .bind(decision, iso(now), id),
    db
      .prepare(
        `UPDATE items SET status = ?1
         WHERE status = 'queued' AND id = (SELECT item_id FROM queue WHERE id = ?2 AND state = ?1)`,
      )
      .bind(decision, id),
  ]);
  return (flip?.meta.changes ?? 0) > 0;
}

/** Record the force-reply prompt message the Edit button produced. */
export async function markEditPrompt(db: D1Database, id: number, promptMessageId: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE queue SET edit_prompt_message_id = ?1 WHERE id = ?2 AND state = 'pending'`)
    .bind(promptMessageId, id)
    .run();
  return res.meta.changes > 0;
}

/** Owner replied to an edit prompt: store corrected text, state -> edited (approved-with-changes). */
export async function applyEditReply(
  db: D1Database,
  promptMessageId: number,
  editedText: string,
  now: Date = new Date(),
): Promise<number | null> {
  const [flip] = await db.batch([
    db
      .prepare(
        `UPDATE queue SET state = 'edited', edited_text = ?1, decided_at = ?2
         WHERE edit_prompt_message_id = ?3 AND state = 'pending'
         RETURNING id, item_id`,
      )
      .bind(editedText, iso(now), promptMessageId),
    db
      .prepare(
        `UPDATE items SET status = 'approved'
         WHERE status = 'queued'
           AND id IN (SELECT item_id FROM queue WHERE edit_prompt_message_id = ?1 AND state = 'edited')`,
      )
      .bind(promptMessageId),
  ]);
  const row = (flip?.results as Array<{ id: number; item_id: number }> | undefined)?.[0];
  return row?.id ?? null;
}

/** Look up a queue entry by its edit-prompt message id, regardless of state (late-reply feedback). */
export async function getQueueEntryByEditPrompt(
  db: D1Database,
  promptMessageId: number,
): Promise<{ id: number; state: string } | null> {
  const row = await db
    .prepare(`SELECT id, state FROM queue WHERE edit_prompt_message_id = ?1`)
    .bind(promptMessageId)
    .first<{ id: number; state: string }>();
  return row ?? null;
}

/** Expire stale pending entries; returns the expired rows for best-effort Telegram message updates. */
/** Per-sweep cap: keeps one expiry run bounded against the 50-subrequest tick budget. */
export const EXPIRY_SWEEP_LIMIT = 25;

export async function expirePendingBefore(
  db: D1Database,
  cutoff: Date,
  now: Date = new Date(),
): Promise<
  Array<{ id: number; telegramMessageId: number | null; draftText: string; editPromptMessageId: number | null }>
> {
  // Atomic batch: bounded flip + a SELF-HEALING mirror that also repairs any
  // items stranded 'queued' by a past partial failure (mirror keys on the
  // queue's expired set, not just this sweep's rows).
  const [flip] = await db.batch([
    db
      .prepare(
        `UPDATE queue SET state = 'expired', decided_at = ?1
         WHERE id IN (SELECT id FROM queue WHERE state = 'pending' AND created_at <= ?2 ORDER BY id LIMIT ${EXPIRY_SWEEP_LIMIT})
         RETURNING id, item_id, telegram_message_id, draft_text, edit_prompt_message_id`,
      )
      .bind(iso(now), iso(cutoff)),
    db.prepare(
      `UPDATE items SET status = 'expired'
       WHERE status = 'queued' AND id IN (SELECT item_id FROM queue WHERE state = 'expired')`,
    ),
  ]);
  const rows =
    (flip?.results as Array<{
      id: number;
      item_id: number;
      telegram_message_id: number | null;
      draft_text: string;
      edit_prompt_message_id: number | null;
    }>) ?? [];
  return rows.map((r) => ({
    id: r.id,
    telegramMessageId: r.telegram_message_id,
    draftText: r.draft_text,
    editPromptMessageId: r.edit_prompt_message_id,
  }));
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
