import { log } from "../lib/log";

// P4-20: refuse to serve a webhook whose schema is behind the code.
//
// THE INCIDENT THIS EXISTS FOR (2026-08-02). Workers Builds auto-deploys every
// merge; `wrangler d1 migrations apply` is a separate manual step. p4-09a
// merged and deployed, so `recordManualPost` began writing six `post_log`
// columns that did not exist yet. The batch threw, `handleTelegramWebhook`
// caught it and returned **200** — its retry branch fires only for
// `update.message`, not `callback_query` — and `processed_updates` had ALREADY
// CLAIMED the update_id.
//
// So the owner's "Posted" tap silently did nothing, showed no error, and could
// never be redelivered. The tap looked like it worked.
//
// WHY A CALL-SITE GUARD IS THE WRONG FIX, which is the part worth keeping:
// `ownerFinals` READS and can degrade to the committed exemplar bank, so a
// missing-table guard there is cheap and obviously right — and it was written.
// `recordManualPost` WRITES and has nothing to degrade to, which makes a guard
// there feel wrong to write, and is exactly why that path got none. The soft
// dependency was hardened and the hard one was not.
//
// A path with no graceful degradation cannot be guarded at its call site. The
// check has to run BEFORE the path is reachable and refuse to serve rather
// than half-serve.
//
// AND THE REFUSAL MUST NOT CONSUME THE UPDATE. The defect was not that it
// broke — it is that it broke while claiming the update_id. This asserts
// before the `processed_updates` insert and returns 500, so Telegram
// redelivers: zero lost taps, and automatic recovery the moment the migration
// lands, with no operator action beyond applying it.

/**
 * The schema the webhook's WRITE paths depend on.
 *
 * Columns, not just tables: the incident was five missing COLUMNS on a table
 * that existed. `test/schemaGuard.test.ts` parses this file's writers and
 * fails if any column they name is absent here, so the list cannot drift from
 * the statements it protects — the alternative is a hand-maintained second
 * copy, which is how the exemplar bank and the fabrication floor spent four
 * days disagreeing.
 */
export const REQUIRED_SHAPE: ReadonlyArray<{ readonly table: string; readonly columns: readonly string[] }> = [
  {
    table: "processed_updates",
    columns: ["update_id", "received_at"],
  },
  {
    table: "post_log",
    columns: [
      "queue_id", "platform_post_id", "posted_at", "archetype", "category",
      "posted_manually", "final_text", "draft_text", "draft_variant",
      "edit_distance", "payload_field_count", "grounding_chars",
    ],
  },
  {
    table: "voice_finals",
    columns: ["queue_id", "archetype", "register", "text", "was_edited", "promoted_at"],
  },
  {
    table: "cards",
    columns: [
      "queue_id", "telegram_message_id", "delivered_at", "cycle", "chosen_variant",
      "posted_state", "posted_prompt_message_id", "posted_prompt_variant",
      "posted_prompt_draft", "edit_prompt_message_id", "updated_at",
    ],
  },
  // Found by the parity test on its first run, against the list above — which
  // I had written from the columns the INCIDENT touched rather than from the
  // columns the webhook writes. The same "encode the instance, not the class"
  // error the guard exists to catch, committed while writing the guard.
  { table: "items", columns: ["id", "status"] },
  { table: "queue", columns: ["id", "state", "edited_text", "edit_prompt_message_id", "decided_at", "skeleton_id", "beat_id"] },
];

/**
 * Cached per BINDING, and only on success.
 *
 * Keyed on the D1Database rather than held in a module flag, because module
 * state is per-isolate and shared across every env an isolate ever sees. That
 * is harmless today with one binding — but a schema verdict cached from a
 * different binding is precisely the class this file exists to prevent, and a
 * guard whose own cache can be stale is a poor advertisement for itself. A
 * collected binding takes its entry with it.
 *
 * A FAILURE IS NEVER CACHED. It would outlive the migration that fixes it,
 * turning a self-healing 500 into a permanent one until the next cold start —
 * the same dead-recovery-path shape as a suppression whose digest never sends.
 */
const verified = new WeakMap<D1Database, true>();

/**
 * Test seam, and it survives the WeakMap for a measured reason: this pool
 * hands every case in a file the SAME `env.DB` object (checked), so a
 * per-binding cache persists across cases exactly as a module flag would. The
 * WeakMap is a production correctness improvement, not a way to delete this.
 */
export function resetSchemaGuardForTest(db?: D1Database): void {
  if (db) verified.delete(db);
}

/** The missing object, or null when the schema satisfies the writers. */
export async function findSchemaGap(db: D1Database): Promise<string | null> {
  if (verified.has(db)) return null;

  // LIMIT 0 exercises the REAL schema and returns no rows: a missing table or
  // column is an error, a present one costs nothing. Comparing against
  // sqlite_master strings would be a second parser to keep correct.
  const probes = REQUIRED_SHAPE.map(({ table, columns }) =>
    db.prepare(`SELECT ${columns.join(", ")} FROM ${table} LIMIT 0`),
  );

  try {
    // ONE round trip for all of them. This runs on the owner's tap latency at
    // cold start, and six sequential D1 hops is the cost that matters here —
    // not the query allowance, which is nowhere near binding.
    await db.batch(probes);
    verified.set(db, true);
    return null;
  } catch {
    // The batch says something failed, not WHICH — so identify on the slow
    // path, which only runs when the schema is already broken. Naming the
    // object is the difference between a 500 the owner can act on and one he
    // has to bisect.
    for (const { table, columns } of REQUIRED_SHAPE) {
      try {
        await db.prepare(`SELECT ${columns.join(", ")} FROM ${table} LIMIT 0`).all();
      } catch (e) {
        return `${table} (${String(e).slice(0, 160)})`;
      }
    }
    // Every probe passed individually: the batch failed for some other reason.
    // Say so rather than reporting a clean schema, which would send the reader
    // looking in the wrong place.
    return "schema probe batch failed but every table probed clean";
  }
}
