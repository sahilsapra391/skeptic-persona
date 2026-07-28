import type { Env } from "../env";
import type { TickBudget } from "../lib/budget";
import { newTickBudget } from "../lib/budget";
import { sendMessage } from "../lib/telegram";
import { iso } from "../lib/time";
import { log } from "../lib/log";
import { ARCHETYPES, renderForQueue } from "../templates";
import type { ArchetypeId, Payload } from "../templates/types";
import { evaluateGate } from "../templates/gate";
import { fillSlots } from "../templates/render";
import { fitsInPost } from "../templates/length";
import { chatComplete, OpenRouterError, parseVariants } from "./openrouter";
import { OWNER_EXEMPLARS, stylePackFor } from "./stylepack";
import { openerHash, skeletonHash } from "./echo";
import { validateVariant, type Variant } from "./validate";

// The generation job (docs/p2r-plan.md Part D): approved queue rows become
// three copy-ready variants. Runs AFTER the Approve tap, so the template
// engine and enqueueForApproval are untouched; the owner approved the FACTS
// (the wire draft), and this step re-voices them without ever re-sourcing
// them.
//
// The fallback chain never ends in silence:
//   generated variant -> (validation fail, regenerate once) -> template
//   draft_text -> (over the new 280 budget? re-render under current rules)
//   -> if even that fails, a LOUD Telegram message naming the queue id.
//
// DOCTRINE DEBT PAID (p2r-01 record): the publish-time register guard that
// went unreachable when the poster parked is reinstated here — checkRegister
// runs inside validateVariant on every variant, and the template fallback is
// re-rendered by the same engine that guarantees doctrine by construction.

export const MAX_GENERATIONS_PER_RUN = 3;

const VARIANTS: readonly Variant[] = ["dry", "sharp", "commentary"];

interface GenRow {
  queue_id: number;
  item_id: number;
  archetype: string;
  draft_text: string;
  edited_text: string | null;
  payload: string;
  source_url: string;
}

/** Beats whose gates PASS for this payload — the only beats the model sees.
 *  A beat with an unmet gate never reaches the prompt (persona.md section 8). */
export function eligibleBeats(archetypeId: ArchetypeId, payload: Payload): string[] {
  const archetype = ARCHETYPES[archetypeId];
  if (!archetype) return [];
  for (const guard of archetype.guards ?? []) if (!guard.ok(payload)) return [];
  const out: string[] = [];
  for (const beat of archetype.beats) {
    if (beat.tier === "signature") continue; // owner-fired only, never via LLM
    if (!evaluateGate(beat.when, payload)) continue;
    const text = fillSlots(beat.text, payload);
    if (text !== null) out.push(text);
  }
  return out;
}

export function buildPrompt(
  archetypeId: ArchetypeId,
  payload: Payload,
  sourceUrl: string,
  exemplars: ReadonlyArray<{ archetype: ArchetypeId; text: string }>,
): { system: string; user: string } {
  const beats = eligibleBeats(archetypeId, payload);
  const system = [
    stylePackFor(archetypeId),
    "OWNER EXEMPLARS (the voice to match; these outrank everything above on tone):",
    ...exemplars.map((e) => `---\n${e.text}\n---`),
    beats.length > 0
      ? `ELIGIBLE BEATS for this item (pre-gated against the payload; you may use AT MOST one, verbatim or not at all):\n${beats.map((b) => `- ${b}`).join("\n")}`
      : "ELIGIBLE BEATS: none. Do not invent a beat.",
  ].join("\n\n");

  const user = [
    "PAYLOAD (the ONLY source of facts; every number, name, ticker, date and code in your output must appear here; derived figures are already computed as fields — never do arithmetic):",
    JSON.stringify(payload, null, 1),
    `SOURCE (rides in a reply, not in the post; do not include the URL): ${sourceUrl}`,
    `ARCHETYPE: ${archetypeId}`,
    "TASK: write THREE variants of one post about this payload, as strict JSON:",
    `{"dry": "...", "sharp": "...", "commentary": "..."}`,
    "- dry: wire register, 100-140 weighted chars. Fact block + attribution, then at most one eligible beat on its own line.",
    "- sharp: same structure, the escalation register: the sharpest ELIGIBLE beat, compression at maximum.",
    "- commentary: 200-280 weighted chars. Fact block with attribution FIRST (it must survive being screenshotted alone), blank line, then the take: opinionated, a real point of view, no hedging, no advice, no imputed motive. The take states what the record shows and stops.",
    "Rules for all three: attribution on the fact block. No hashtags, no questions, no em-dashes, no BREAKING, no URLs. Numbers exactly as they appear in the payload (bands stay bands).",
    "Reply with the JSON object only.",
  ].join("\n");

  return { system, user };
}

async function insertGeneration(
  db: D1Database,
  row: { queueId: number; variant: Variant | "none"; text: string; status: string; attempt: number },
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO generations (queue_id, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      row.queueId,
      row.variant,
      row.text,
      row.text === "" ? "" : skeletonHash(row.text),
      row.text === "" ? "" : openerHash(row.text),
      row.status,
      row.attempt,
      iso(now),
    )
    .run();
}

async function alertOwner(env: Env, text: string, budget: TickBudget): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !budget.take(1)) return;
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  } catch (e) {
    log("warn", "generation alert failed", { error: String(e) });
  }
}

export interface GenerationDeps {
  /** Injectable for tests; defaults to the committed bank. */
  exemplars?: ReadonlyArray<{ archetype: ArchetypeId; text: string }>;
}

export async function runGeneration(
  env: Env,
  now: Date,
  budget: TickBudget = newTickBudget(),
  deps: GenerationDeps = {},
): Promise<void> {
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) return; // not configured; queue holds
  const exemplars = deps.exemplars ?? OWNER_EXEMPLARS;

  // Approved rows with no generation attempt yet. The 'none' marker row from
  // the exemplar gate keeps a row from being re-picked every 5 minutes.
  const rows = await env.DB.prepare(
    `SELECT q.id AS queue_id, q.item_id, q.archetype, q.draft_text, q.edited_text,
            i.payload, i.source_url
     FROM queue q
     JOIN items i ON i.id = q.item_id
     LEFT JOIN generations g ON g.queue_id = q.id
     WHERE q.state IN ('approved', 'edited') AND g.id IS NULL
       AND i.source <> 'smoke_test'
     ORDER BY q.decided_at
     LIMIT ?1`,
  )
    .bind(MAX_GENERATIONS_PER_RUN)
    .all<GenRow>();
  if (rows.results.length === 0) return;

  let warnedCorpusEmpty = false;

  for (const row of rows.results) {
    const archetypeId = row.archetype as ArchetypeId;
    let payload: Payload;
    try {
      payload = JSON.parse(row.payload) as Payload;
    } catch {
      log("error", "generation: unparseable payload", { queueId: row.queue_id });
      await insertGeneration(env.DB, { queueId: row.queue_id, variant: "none", text: "", status: "rejected:payload", attempt: 1 }, now);
      continue;
    }

    // THE EXEMPLAR GATE. No owner exemplar for this archetype = no LLM call.
    // The card (p2r-05) shows the template draft; the marker row records why.
    const bank = exemplars.filter((e) => e.archetype === archetypeId);
    if (bank.length === 0) {
      await insertGeneration(env.DB, { queueId: row.queue_id, variant: "none", text: "", status: "skipped_no_exemplar", attempt: 1 }, now);
      log("info", "generation skipped: no owner exemplar for archetype", { queueId: row.queue_id, archetype: archetypeId });
      continue;
    }

    // The template fallback, budget-checked NOW under current rules: a draft
    // rendered before the 280 retarget may no longer fit (4 live rows do
    // not). Re-render rather than truncate — what was approved structurally
    // is what posts, but the render is refreshed under the current budget.
    let fallback = row.edited_text ?? row.draft_text;
    if (!fitsInPost(fallback)) {
      const re = await renderForQueue(env, archetypeId, payload, `${archetypeId}:${row.item_id}`);
      if (re.ok) {
        fallback = re.text;
        log("info", "generation: stale over-budget draft re-rendered", { queueId: row.queue_id });
      } else {
        // The loud terminal case: generation may still succeed below, but if
        // it does not, this post has nowhere to go — say so NOW.
        await alertOwner(
          env,
          `⚠️ #${row.queue_id}: the approved draft exceeds the 280 budget and a re-render failed (${re.reason}). If generation also fails, this item is held — it will not be silently dropped.`,
          budget,
        );
      }
    }

    const prompt = buildPrompt(archetypeId, payload, row.source_url, bank);

    // Per-variant: attempt 2 regenerates only the variants that have not
    // yet produced a valid row ("dropped and regenerated once", per plan).
    const valid = new Set<Variant>();
    for (let attempt = 1; attempt <= 2 && valid.size < VARIANTS.length; attempt++) {
      if (!budget.take(1, { reserved: true })) break;
      let content: string;
      try {
        content = await chatComplete(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ]);
      } catch (e) {
        if (e instanceof OpenRouterError && e.isAuthInvalid) {
          log("error", "openrouter key invalid; generation paused", { queueId: row.queue_id });
          await alertOwner(env, "⚠️ OpenRouter key is invalid or missing credit. Generation is paused; approved items keep their template drafts.", budget);
          return; // no point continuing the run
        }
        log("error", "openrouter call failed", { queueId: row.queue_id, attempt, error: String(e) });
        continue; // the retry attempt (or fall through to fallback)
      }

      const variants = parseVariants(content);
      for (const v of VARIANTS) {
        if (valid.has(v)) continue; // already good from attempt 1
        const text = variants[v];
        if (!text) {
          await insertGeneration(env.DB, { queueId: row.queue_id, variant: v, text: "", status: "rejected:absent", attempt }, now);
          continue;
        }
        const result = await validateVariant(env.DB, text, {
          queueId: row.queue_id,
          variant: v,
          archetype: archetypeId,
          payload,
          templateDraft: fallback,
          skeletonHash: skeletonHash(text),
          openerHash: openerHash(text),
        });
        if (result.corpusEmpty && !warnedCorpusEmpty) {
          warnedCorpusEmpty = true;
          log("warn", "echo_ngrams is empty; corpus echo check is a no-op (run scripts/build-echo-hashes.mjs)");
        }
        const status = result.issues.length === 0 ? "valid" : `rejected:${result.issues[0]!.rule}`;
        await insertGeneration(env.DB, { queueId: row.queue_id, variant: v, text, status, attempt }, now);
        if (result.issues.length === 0) valid.add(v);
        else log("info", "variant rejected", { queueId: row.queue_id, variant: v, attempt, issues: result.issues.map((i) => i.rule).join(",") });
      }
    }

    if (valid.size === 0) {
      // Every variant of every attempt failed. The card falls back to the
      // template draft — which exists and fits (or the owner was already
      // alerted above). Recorded, not silent.
      await insertGeneration(env.DB, { queueId: row.queue_id, variant: "none", text: fallback, status: "fallback_template", attempt: 2 }, now);
      log("warn", "generation fell back to template for queue row", { queueId: row.queue_id });
    }
  }
}
