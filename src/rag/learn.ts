import type { ArchetypeId } from "../templates/types";
import type { CardVariant } from "./deliver";
import type { OwnerExemplar } from "./stylepack";
import { iso } from "../lib/time";

// P4-09: the learning loop.
//
// The pipeline's output is a draft; the owner's output is a post. The gap
// between those two strings is the only honest measure of whether any of this
// works, and until now it was thrown away — post_log kept the final and not
// the draft it replaced.
//
// The headline metric is the ZERO-EDIT RATE: of the posts the owner actually
// published, what fraction went out exactly as generated. That is the stated
// goal of the whole track ("a post I copy-paste to X with ZERO edits"), so it
// is the number the nightly digest leads with.
//
// Two rules this module exists to enforce:
//
//  1. A pair is captured, never re-derived. resolveVariantText() returns the
//     LATEST valid attempt, so re-deriving a draft after a regeneration
//     returns a string the owner never saw, and it would look exactly like a
//     real pair. Capture happens once, in the batch that records the post.
//  2. NO DATA IS NOT A SCORE OF ZERO. With nothing published, the zero-edit
//     rate is undefined, and every function here returns that distinctly
//     rather than dividing by zero into a confident-looking 0%.

/** How much the owner changed, as a fact about two specific strings. */
export interface EditPair {
  readonly queueId: number;
  readonly archetype: string;
  readonly variant: string | null;
  readonly draft: string;
  readonly final: string;
  readonly distance: number;
  /** distance / max(len) — 0 shipped verbatim, 1 rewritten from scratch. */
  readonly ratio: number;
}

/**
 * Levenshtein distance, two-row variant.
 *
 * Bounded on purpose: posts are capped at 280 weighted characters, so the
 * worst case here is roughly 280x280 cells on a path that runs once per
 * posted card, not per tick. The guard is for pathological input (a pasted
 * essay in the Edit reply), where the exact distance stops being meaningful
 * anyway and the ratio saturates at 1.
 */
export const EDIT_DISTANCE_MAX_LEN = 2000;

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > EDIT_DISTANCE_MAX_LEN || b.length > EDIT_DISTANCE_MAX_LEN) {
    return Math.max(a.length, b.length);
  }
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, sub);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

export function editRatio(draft: string, final: string): number {
  const longest = Math.max(draft.length, final.length);
  return longest === 0 ? 0 : editDistance(draft, final) / longest;
}

/**
 * The register a promoted final rides under, so the bank and the committed
 * exemplars are the same shape at the injection point. 'dry' and 'sharp' are
 * wire registers; 'commentary' is its own. A 'template' fallback is NOT
 * promoted at all — it is our own boilerplate, and feeding it back as an
 * exemplar would teach the model to reproduce the thing generation exists to
 * replace.
 */
export function registerFor(variant: string | null): "wire" | "commentary" | null {
  if (variant === "commentary") return "commentary";
  if (variant === "sharp" || variant === "dry") return "wire";
  return null; // 'template', null, or anything unrecognised
}

export interface PromotionInput {
  readonly queueId: number;
  readonly archetype: string;
  readonly variant: CardVariant | string | null;
  readonly finalText: string;
  readonly wasEdited: boolean;
}

/**
 * Statement form so the caller can put it in the SAME atomic batch as the
 * post_log claim. A promotion that lands without its post, or a post whose
 * promotion silently failed, is a split record — and the loop's whole value
 * is that the two agree.
 *
 * Returns null when there is nothing to promote (template fallback, or empty
 * text), which the caller treats as "no statement", not as an error.
 */
export function promotionStatement(db: D1Database, now: Date, input: PromotionInput): D1PreparedStatement | null {
  const register = registerFor(typeof input.variant === "string" ? input.variant : null);
  if (register === null) return null;
  const text = input.finalText.trim();
  if (text === "") return null;
  // Re-answering a card repairs the row rather than appending a rival one.
  return db
    .prepare(
      `INSERT INTO voice_finals (queue_id, archetype, register, text, was_edited, promoted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(queue_id) DO UPDATE SET
         text = excluded.text, register = excluded.register,
         was_edited = excluded.was_edited, promoted_at = excluded.promoted_at`,
    )
    .bind(input.queueId, input.archetype, register, text, input.wasEdited ? 1 : 0, iso(now));
}

/**
 * Owner finals for an archetype, newest first, shipped-unedited ranked above
 * rewritten.
 *
 * The ordering is the opposite of what "learn from corrections" suggests, and
 * deliberately: an unedited final is a draft the model already got right, so
 * it is proof the voice is reachable from this prompt. A rewritten final is
 * the owner's voice but not evidence the model can reach it. Both are useful;
 * only the first is evidence.
 */
export async function ownerFinals(
  db: D1Database,
  archetype: ArchetypeId,
  limit: number,
): Promise<OwnerExemplar[]> {
  if (limit <= 0) return [];
  const rows = await db
    .prepare(
      `SELECT register, text FROM voice_finals
       WHERE archetype = ?1
       ORDER BY was_edited ASC, promoted_at DESC
       LIMIT ?2`,
    )
    .bind(archetype, limit)
    .all<{ register: string; text: string }>();
  return rows.results.map((r) => ({
    archetype,
    register: r.register === "commentary" ? ("commentary" as const) : ("wire" as const),
    text: r.text,
  }));
}

/**
 * The headline metric, plus the counts it is derived from.
 *
 * `rate` is null when nothing has been published in the window. Null is not
 * 0: a pipeline that has posted nothing has not achieved a 0% zero-edit rate,
 * it has no rate. Every caller must render that distinction rather than
 * formatting null into a number.
 */
export interface ZeroEditStats {
  readonly posted: number;
  readonly unedited: number;
  readonly edited: number;
  /** Posted before pair capture existed — countable, not scoreable. */
  readonly uncaptured: number;
  readonly rate: number | null;
  /** Mean edit ratio over EDITED posts only; null when there are none. */
  readonly meanEditRatio: number | null;
}

export async function zeroEditStats(db: D1Database, since: Date): Promise<ZeroEditStats> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS posted,
         SUM(CASE WHEN edit_distance = 0 THEN 1 ELSE 0 END) AS unedited,
         SUM(CASE WHEN edit_distance > 0 THEN 1 ELSE 0 END) AS edited,
         SUM(CASE WHEN edit_distance IS NULL THEN 1 ELSE 0 END) AS uncaptured
       FROM post_log
       WHERE posted_manually = 1 AND posted_at >= ?1`,
    )
    .bind(iso(since))
    .first<{ posted: number; unedited: number | null; edited: number | null; uncaptured: number | null }>();

  const posted = row?.posted ?? 0;
  const unedited = row?.unedited ?? 0;
  const edited = row?.edited ?? 0;
  const uncaptured = row?.uncaptured ?? 0;
  // Scoreable = the pairs we actually captured. Rows from before capture
  // existed are reported separately and never enter the denominator.
  const scoreable = unedited + edited;

  let meanEditRatio: number | null = null;
  if (edited > 0) {
    const m = await db
      .prepare(
        `SELECT AVG(CAST(edit_distance AS REAL) / MAX(LENGTH(draft_text), LENGTH(final_text))) AS r
         FROM post_log
         WHERE posted_manually = 1 AND posted_at >= ?1 AND edit_distance > 0
           AND draft_text IS NOT NULL AND final_text IS NOT NULL
           AND MAX(LENGTH(draft_text), LENGTH(final_text)) > 0`,
      )
      .bind(iso(since))
      .first<{ r: number | null }>();
    meanEditRatio = m?.r ?? null;
  }

  return {
    posted,
    unedited,
    edited,
    uncaptured,
    rate: scoreable === 0 ? null : unedited / scoreable,
    meanEditRatio,
  };
}

/**
 * Why the draft looked the way it did, captured alongside the pair.
 *
 * AN EDIT IS NOT ALWAYS A VOICE SIGNAL. If the owner rewrote a draft because
 * the payload was thin — five fields and no source text — that pair does not
 * teach the model to write better, it teaches it to compensate for missing
 * facts, which is a fabrication pressure wearing a style lesson's clothes.
 * Telling those apart later needs the context now: a pair captured without it
 * is a question that can never be asked about the days already past.
 *
 * Nothing consumes these yet, deliberately. They are cheap at capture and
 * impossible to backfill.
 */
export interface PairContext {
  readonly payloadFieldCount: number | null;
  readonly groundingChars: number | null;
}

/** Top-level payload keys with a non-empty value, plus captured body length. */
export async function pairContext(db: D1Database, queueId: number): Promise<PairContext> {
  const row = await db
    .prepare(
      `SELECT i.payload, LENGTH(COALESCE(i.raw_text, '')) AS body
       FROM queue q JOIN items i ON i.id = q.item_id WHERE q.id = ?1`,
    )
    .bind(queueId)
    .first<{ payload: string; body: number }>();
  if (!row) return { payloadFieldCount: null, groundingChars: null };
  let fields: number | null = null;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      fields = Object.values(parsed as Record<string, unknown>).filter(
        (v) => v !== null && v !== undefined && v !== "",
      ).length;
    }
  } catch {
    fields = null; // an unparseable payload is unknown depth, not zero depth
  }
  return { payloadFieldCount: fields, groundingChars: row.body };
}

/** The captured pairs themselves, for the digest's "what changed" section. */
export async function recentEditedPairs(db: D1Database, since: Date, limit: number): Promise<EditPair[]> {
  const rows = await db
    .prepare(
      `SELECT queue_id, archetype, draft_variant, draft_text, final_text, edit_distance
       FROM post_log
       WHERE posted_manually = 1 AND posted_at >= ?1 AND edit_distance > 0
         AND draft_text IS NOT NULL AND final_text IS NOT NULL
       ORDER BY posted_at DESC
       LIMIT ?2`,
    )
    .bind(iso(since), limit)
    .all<{
      queue_id: number;
      archetype: string;
      draft_variant: string | null;
      draft_text: string;
      final_text: string;
      edit_distance: number;
    }>();
  return rows.results.map((r) => {
    const longest = Math.max(r.draft_text.length, r.final_text.length);
    return {
      queueId: r.queue_id,
      archetype: r.archetype,
      variant: r.draft_variant,
      draft: r.draft_text,
      final: r.final_text,
      distance: r.edit_distance,
      ratio: longest === 0 ? 0 : r.edit_distance / longest,
    };
  });
}
