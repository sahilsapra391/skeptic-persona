import type { Env } from "../env";
import { ARCHETYPES } from "./archetypes";
import { EMPTY_ROTATION, renderPost, type RenderResult, type RotationState } from "./render";
import type { ArchetypeId, Payload } from "./types";

export { ARCHETYPES, PENDING_BEATS } from "./archetypes";
export { renderPost, seedHash, THREADS_TEXT_LIMIT } from "./render";
export type { RenderResult, RotationState } from "./render";
export * from "./types";

/** How many recent posts define "consecutive" for the rotation invariant. */
export const ROTATION_WINDOW = 4;

/**
 * Rotation state from D1: the skeleton/beat ids on the most recent queue rows
 * of this archetype. The ledger lives on the row we already INSERT, so
 * rotation costs zero extra writes (KV free tier is 1k writes/day; a
 * per-render KV write would be a needless risk).
 */
export async function loadRotation(env: Env, archetype: ArchetypeId): Promise<RotationState> {
  const rows = await env.DB.prepare(
    `SELECT skeleton_id, beat_id FROM queue
     WHERE archetype = ?1 AND skeleton_id IS NOT NULL
       AND state IN ('pending', 'approved', 'edited')
     ORDER BY id DESC LIMIT ?2`,
  )
    .bind(archetype, ROTATION_WINDOW)
    .all<{ skeleton_id: string | null; beat_id: string | null }>();
  return {
    recentSkeletons: rows.results.map((r) => r.skeleton_id).filter((v): v is string => v !== null),
    recentBeats: rows.results.map((r) => r.beat_id).filter((v): v is string => v !== null),
  };
}

/**
 * Render at ENQUEUE time (never at ingest): what Sahil approves in Telegram
 * is byte-identical to what posts, and rotation reflects what actually went
 * into the queue.
 */
export async function renderForQueue(
  env: Env,
  archetypeId: ArchetypeId,
  payload: Payload,
  seed: string,
): Promise<RenderResult> {
  const archetype = ARCHETYPES[archetypeId];
  if (!archetype) return { ok: false, reason: "unknown_archetype" };
  let rotation: RotationState = EMPTY_ROTATION;
  try {
    rotation = await loadRotation(env, archetypeId);
  } catch {
    // Rotation is an optimization, not a correctness gate: a DB hiccup must
    // not block a wire post. Worst case a skeleton repeats.
  }
  return renderPost(archetype, payload, { seed, rotation });
}
