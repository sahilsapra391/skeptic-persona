import type { Env } from "../env";
import type { TickBudget } from "../lib/budget";
import { newTickBudget } from "../lib/budget";
import { sendMessage } from "../lib/telegram";
import { iso } from "../lib/time";
import { log } from "../lib/log";
import { ARCHETYPES, renderForQueue } from "../templates";
import type { ArchetypeId, Payload } from "../templates/types";
import { evaluateGate } from "../templates/gate";
import { fillSlots, resolveAttribution } from "../templates/render";
import { fitsInPost } from "../templates/length";
import { checkRegister } from "../templates/validate";
import { chatComplete, OpenRouterError, parseVariants } from "./openrouter";
import { OWNER_EXEMPLARS, stylePackFor } from "./stylepack";
import { ownerFinals } from "./learn";
import { fetchSourceText, hasDedicatedCapture, isBlockedGroundingHost, type SourceText } from "./sourceText";
import { lakeContext } from "./context";
import { openerHash, skeletonHash } from "./echo";
import { checkGroundingProvenance, type GroundingProvenance, corpusHasData, validateVariant, type ValidationIssue, type Variant } from "./validate";

// The generation job (docs/p2r-plan.md Part D): approved queue rows become
// three copy-ready variants. Runs AFTER the Approve tap, so the template
// engine and enqueueForApproval are untouched; the owner approved the FACTS
// (the wire draft), and this step re-voices them without re-sourcing them.
//
// LIFECYCLE (hardened after the 45-agent review; findings #7-#9):
//   A queue row is DONE when it has a TERMINAL generations row:
//     'valid' | 'fallback_template' | 'fallback_blocked' |
//     'skipped_no_exemplar' | 'rejected:payload'
//   Selection picks rows WITHOUT a terminal row — so a crash that leaves
//   only rejected:*/api_error rows is retried next tick instead of
//   stranding the row forever (finding #8), and a transient OpenRouter
//   429/5xx retries on the 5-minute cadence instead of permanently
//   downgrading the row to the template (finding #9). Runaway retries are
//   capped: MAX_ATTEMPTS LLM attempts per CYCLE, then fallback.
//   Attempt numbers CONTINUE across runs (max existing + 1) so the audit
//   trail never collides with UNIQUE(queue_id, variant, attempt).
//
//   CYCLES (p5-01): terminal-ness is scoped to q.regen_cycle, and generation
//   history is append-only. Regenerate and the card-Edit reply increment the
//   cursor rather than deleting the row's drafts, so a re-picked row starts
//   its new cycle with a full MAX_ATTEMPTS budget while every prior draft
//   stays readable. Numbering is global per row; the BUDGET is per cycle.
//   Those two must not be conflated: shared numbering is what keeps the
//   UNIQUE constraint intact without a table rebuild.
//
// OVERLAP (finding #7): the dispatcher's CAS prevents double-claiming a due
// slot but not a run outliving its own cadence window. RUN_TIME_CAP_MS stops
// STARTING new rows well before the next fire, so two invocations cannot
// process the same row concurrently.
//
// DOCTRINE DEBT PAID, precisely (finding #12 corrected an overclaim): the
// parked publish-time register guard is reinstated for BOTH paths here —
// generated variants pass checkRegister inside validateVariant, and the
// template fallback (draft_text/edited_text, which may be hand-typed) is
// register-checked at fallback time; a failing fallback is re-rendered by
// the engine, and if even that fails the row is HELD as fallback_blocked
// with a loud alert, never shown as copy-ready.

export const MAX_GENERATIONS_PER_RUN = 3;
/** Total LLM attempts per queue row across all runs before falling back. */
export const MAX_ATTEMPTS = 4;
/** Stop starting new rows after this much wall time (cadence is 300s). */
export const RUN_TIME_CAP_MS = 120_000;
/**
 * CEILING on owner finals injected per archetype (p4-09). The EFFECTIVE limit
 * is `floor((committed - 1) / 2)` — see the call site — so promoted text is
 * always a strict minority of the bank. This constant only stops a large
 * committed bank from pulling in an unbounded number of finals; for every
 * archetype we have today the relative rule binds first, and for the
 * two-exemplar archetypes it allows nothing at all until the owner writes a
 * third. That is the correct answer for a thin bank rather than a limitation:
 * there is no range there to outweigh.
 */
export const MAX_OWNER_FINALS = 4;

/**
 * How many promoted finals may ride alongside a committed bank of this size.
 *
 * Exported because it is the containment for voice collapse and a formula
 * buried in a call site is a formula nobody tests. Strict minority by
 * construction: at 2 committed exemplars it returns 0, which is correct rather
 * than unfortunate — there is no signed-off range there to outweigh, so the
 * loop contributes nothing until the owner writes a third.
 */
export function ownerFinalsAllowance(committedCount: number): number {
  if (committedCount <= 0) return 0;
  return Math.min(MAX_OWNER_FINALS, Math.floor((committedCount - 1) / 2));
}

const KV_OPENROUTER_ALERTED = "openrouter:auth_alert_sent";
const KV_ECHO_EMPTY_ALERTED = "echo:empty_alert_sent";

const VARIANTS: readonly Variant[] = ["dry", "sharp", "commentary"];

/**
 * Commentary segment budgets. They sum to under POST_TEXT_LIMIT (280) with
 * room for the blank line, so a draft that honours both parts is inside the
 * post budget by construction. Stated to the model because a total-only
 * budget makes it write a long fact block and then crush the take —
 * observed live on queue #918, where the crush produced a fabricated-looking
 * "April Maduro" compound that entityCheck correctly refused.
 */
export const COMMENTARY_FACT_BUDGET = 120;
export const COMMENTARY_TAKE_BUDGET = 155;

// Terminal-ness is a property of the CURRENT cycle, not of the row's whole
// life (p5-01). Regenerate used to delete the row's history so that this
// predicate would stop matching; it now increments q.regen_cycle instead, and
// the prior cycle's terminal rows stay in place without holding the row shut.
const TERMINAL_PREDICATE = `
  SELECT 1 FROM generations g
  WHERE g.queue_id = q.id
    AND g.cycle = q.regen_cycle
    AND (g.status = 'valid' OR g.status LIKE 'fallback%' OR g.status LIKE 'skipped%' OR g.status = 'rejected:payload')`;

interface GenRow {
  queue_id: number;
  item_id: number;
  regen_cycle: number;
  archetype: string;
  draft_text: string;
  edited_text: string | null;
  payload: string;
  source_url: string;
  source: string;
  raw_text: string | null;
  raw_meta: string | null;
}

/** Beats whose gates PASS for this payload — the only beats the model sees.
 *  A beat with an unmet gate never reaches the prompt (persona.md section 8).
 *
 *  Related-but-different from render.ts's pickBeat, ON PURPOSE: pickBeat
 *  SELECTS one beat (rotation, tier ranking) for a template; this LISTS all
 *  eligible beats as prompt material. Unifying them would silently change
 *  which beats the model sees — leave them separate.
 *
 *  Known limitation (finding #34): lookback enrichment fields are computed
 *  in memory at enqueue time and not persisted to items.payload, so
 *  escalation beats gated on them can never fire here. Flagged to the
 *  ingestion session; fixing it means persisting enrichment, not changing
 *  this function. */
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
  exemplars: ReadonlyArray<{ archetype: ArchetypeId; text: string; register?: "wire" | "commentary" }>,
  feedback: readonly string[] = [],
  grounding?: { source?: SourceText | null; contextLines?: readonly string[] },
): { system: string; user: string } {
  const beats = eligibleBeats(archetypeId, payload);
  const system = [
    stylePackFor(archetypeId),
    "OWNER EXEMPLARS (the voice to match; these outrank everything above on tone). Their NUMBERS are from PAST filings: reusing any number not in this item's payload fails validation. Commentary exemplars may run longer than the platform limit: match their VOICE, obey the 200-280 contract.",
    ...exemplars.map((e) => `--- ${e.register ?? "wire"} ---\n${e.text}\n---`),
    beats.length > 0
      ? `ELIGIBLE BEATS for this item (pre-gated against the payload; you may use AT MOST one, verbatim or not at all):\n${beats.map((b) => `- ${b}`).join("\n")}`
      : "ELIGIBLE BEATS: none. Do not invent a beat.",
  ].join("\n\n");

  // The one citation valid for THIS item, stated to the model verbatim: the
  // first live run produced correct-by-exemplar attributions the validator
  // rejected because the prompt never said which string the gauntlet demands.
  const attribution = resolveAttribution(ARCHETYPES[archetypeId], payload);
  const hasSource = Boolean(grounding?.source?.text);
  const hasContext = Boolean(grounding?.contextLines?.length);
  // Name only the universes actually present below (review cosmetic).
  const factSources =
    hasSource && hasContext
      ? "the payload, the SOURCE DOCUMENT, or the LAKE CONTEXT below"
      : hasSource
        ? "the payload or the SOURCE DOCUMENT below"
        : hasContext
          ? "the payload or the LAKE CONTEXT below"
          : "the payload";
  const modeLabel = (m: string): string => (m === "excerpt" ? "excerpt" : m === "ingest_rss" ? "ingest-captured summary" : "full text");
  const user = [
    `PAYLOAD (every number, name, ticker, date and code in your output must appear in ${factSources}; derived figures are already computed as fields — never do arithmetic, never state relative quantities like 'double' or 'half'):`,
    JSON.stringify(payload, null, 1),
    ...(hasSource
      ? [
          `SOURCE DOCUMENT (${grounding!.source!.host}, fetched ${grounding!.source!.fetchedAt}, ${modeLabel(grounding!.source!.mode)}) — the primary record behind this item; its facts are usable:`,
          // The delimiter must stay ours: third-party text containing """ would
          // end the block early and read from instruction position.
          `"""\n${grounding!.source!.text.replace(/"{3,}/g, "'''")}\n"""`,
        ]
      : []),
    ...(hasContext
      ? [
          "LAKE CONTEXT (our own parsed history, machine-derived; usable in the take to place this item against the record). Cite a prior item by its COUNT or its DATE, or by a phrase copied exactly from its title. Never compress a title into a shorter name, and never merge a date with a name (a April-plus-Maduro compound reads as a person who does not exist and fails validation):",
          ...grounding!.contextLines!.map((l) => `- ${l}`),
        ]
      : []),
    `ARCHETYPE: ${archetypeId}`,
    "TASK: write THREE variants of one post about this payload, as strict JSON:",
    `{"commentary": "...", "sharp": "...", "dry": "..."}`,
    // Segment budgets, not just a total: given only "200-280" the model wrote
    // a 115-char fact block and then crushed the take to fit, which is where
    // lossy name compression (and its fabrication risk) comes from.
    `- commentary (THE deliverable; the other two are fallbacks): 200-280 weighted chars TOTAL, built as two budgeted parts. Fact block FIRST, at most ${COMMENTARY_FACT_BUDGET} weighted chars including the attribution — compress it yourself (drop clause padding, keep every number and name exact); it must survive being screenshotted alone. Then a blank line, then the take, at most ${COMMENTARY_TAKE_BUDGET} weighted chars: one or two short segments (a punch line, then the argument), opinionated, a real point of view, no hedging, no advice, no imputed motive. Engage the SPECIFIC record in the data above — what this actor did, how it sits against the prior record — not generalities about markets. No claims about market reaction (spreads, flows, pricing, positioning) unless stated in the data above. Write it as a standalone post from a market desk: declarative and concrete, no filler, and never restate a fact as if it were the take.`,
    "- sharp: wire register (fact block + attribution, then at most one beat line), the escalation tier: the sharpest ELIGIBLE beat, compression at maximum.",
    "- dry: wire register, 100-140 weighted chars. Fact block + attribution, then at most one eligible beat on its own line.",
    attribution !== null
      ? `Rules for all three: the fact block's head line ends with exactly "${attribution}" — any other citation fails validation. No hashtags, no questions, no em-dashes, no BREAKING, no URLs or links of any kind. Numbers exactly as they appear in ${factSources} (bands stay bands).`
      : `Rules for all three: attribution on the fact block. No hashtags, no questions, no em-dashes, no BREAKING, no URLs or links of any kind. Numbers exactly as they appear in ${factSources} (bands stay bands).`,
    ...(feedback.length > 0
      ? [`PREVIOUS ATTEMPT WAS REJECTED. Fix exactly these and change nothing else:\n${feedback.map((f) => `- ${f}`).join("\n")}`]
      : []),
    "Reply with the JSON object only.",
  ].join("\n");

  return { system, user };
}

async function insertGeneration(
  db: D1Database,
  row: { queueId: number; cycle: number; variant: Variant | "none"; text: string; status: string; attempt: number },
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO generations (queue_id, cycle, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      row.queueId,
      row.cycle,
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

/** Alerts draw the RESERVED pool (an alert about a held post outranks a feed
 *  poll) and dropping one is itself logged loudly (finding #20). */
/** Returns TRUE only when the message actually reached Telegram, so callers
 *  can gate a suppression key on delivery rather than on intent. */
async function alertOwner(env: Env, text: string, budget: TickBudget): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log("error", "generation alert DROPPED: telegram not configured", { alert: text.slice(0, 120) });
    return false;
  }
  if (!budget.take(1, { reserved: true })) {
    log("error", "generation alert DROPPED: budget exhausted", { alert: text.slice(0, 120) });
    return false;
  }
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
    return true;
  } catch (e) {
    log("error", "generation alert send FAILED", { alert: text.slice(0, 120), error: String(e) });
    return false;
  }
}

export interface GenerationDeps {
  /** Injectable for tests; defaults to the committed bank. */
  exemplars?: ReadonlyArray<{ archetype: ArchetypeId; text: string; register?: "wire" | "commentary" }>;
}

/**
 * Decide, in ONE place, whether a source document may license facts — and
 * return both the verdict and the text that survives it.
 *
 * Takes the SourceText rather than a string SO THAT THE CALLER CANNOT FORGET
 * THE MODE. The provenance answer depends on `source.mode`, and when the call
 * site passed it explicitly, deleting that argument left all 946 tests green:
 * a test can assert the two functions agree without asserting that the caller
 * connects them. Reading the mode in here removes the argument, and with it
 * the omission — the same move as making fetchPool's concurrency required.
 * Fourth time in this repo a fix was wired at one call site with nothing
 * pinning the wiring; this is the first one closed by construction.
 */
export function licensedGrounding(
  source: { text: string; mode: string } | null | undefined,
  payload: Payload,
): { provenance: GroundingProvenance; licensed: string } {
  const provenance = checkGroundingProvenance(source?.text ?? "", payload, source?.mode);
  return { provenance, licensed: provenance.ok ? (source?.text ?? "") : "" };
}

export async function runGeneration(
  env: Env,
  now: Date,
  budget: TickBudget = newTickBudget(),
  deps: GenerationDeps = {},
): Promise<void> {
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) return; // not configured; queue holds
  const exemplars = deps.exemplars ?? OWNER_EXEMPLARS;
  const startedAt = performance.now();

  // Rows without a TERMINAL generations row (see LIFECYCLE above).
  const rows = await env.DB.prepare(
    `SELECT q.id AS queue_id, q.item_id, q.archetype, q.draft_text, q.edited_text, q.regen_cycle,
            i.payload, i.source_url, i.source, i.raw_text, i.raw_meta
     FROM queue q
     JOIN items i ON i.id = q.item_id
     WHERE q.state IN ('approved', 'edited')
       AND i.source <> 'smoke_test'
       AND NOT EXISTS (${TERMINAL_PREDICATE})
     ORDER BY q.decided_at
     LIMIT ?1`,
  )
    .bind(MAX_GENERATIONS_PER_RUN)
    .all<GenRow>();
  if (rows.results.length === 0) return;

  // One probe per run, not per variant (finding #22).
  const corpusPopulated = await corpusHasData(env.DB);
  if (!corpusPopulated) {
    // ABSENCE IS NOT EVIDENCE (the lesson the issuer gate paid for): an empty
    // table means "not loaded", never "nothing matches". The check degrades
    // open — style similarity is not doctrine — but it must be LOUD, because
    // this silently no-opped in production from 2026-07-28 to 08-01 and only
    // a manual row count found it. One alert per 24h, not a log line nobody
    // reads.
    log("error", "echo_ngrams is EMPTY; corpus echo check is disabled (run scripts/build-echo-hashes.mjs)");
    if (!(await env.KV.get(KV_ECHO_EMPTY_ALERTED))) {
      // Suppress only AFTER a confirmed send. Writing the key first meant a
      // failed send silenced the alert for 24h having never delivered it —
      // the same silent-success shape as the bug it exists to report.
      const delivered = await alertOwner(
        env,
        "⚠️ echo_ngrams is empty: the corpus-echo check is OFF, so generated drafts are not being screened against competitor phrasing. Load it with scripts/build-echo-hashes.mjs.",
        budget,
      );
      if (delivered) await env.KV.put(KV_ECHO_EMPTY_ALERTED, "1", { expirationTtl: 24 * 3600 });
    }
  }

  for (const row of rows.results) {
    // Overlap guard (finding #7): never start a row we might not finish
    // before the next cadence fire could pick it up again.
    if (performance.now() - startedAt > RUN_TIME_CAP_MS) {
      log("warn", "generation run time cap reached; remaining rows defer to the next tick");
      break;
    }
    const archetypeId = row.archetype as ArchetypeId;

    // Attempt numbering continues across runs AND across cycles (finding #8's
    // UNIQUE-collision corollary, widened by p5-01): a retried row picks up
    // where its audit trail left off. This is computed HERE, above the two
    // early-exit branches below, because both used to write attempt: 1
    // literally. That was safe only while Regenerate deleted history. With
    // history preserved, a second cycle re-writing (queue_id, 'none', 1)
    // collides with the first cycle's row, INSERT OR IGNORE drops it, the
    // row ends the cycle with no terminal row, and the lifecycle re-picks it
    // every tick forever. Silent, and expensive.
    //
    // ONE round trip for both numbers, not two: this runs per row on every
    // generation tick, and the same reasoning that made schemaGuard batch its
    // probes applies to the hot path here.
    const counters = await env.DB.prepare(
      `SELECT COALESCE(MAX(attempt), 0) AS highest,
              COUNT(DISTINCT CASE WHEN cycle = ?2 THEN attempt END) AS spent
       FROM generations WHERE queue_id = ?1`,
    )
      .bind(row.queue_id, row.regen_cycle)
      .first<{ highest: number; spent: number }>();
    let attempt = (counters?.highest ?? 0) + 1;
    // The BUDGET, unlike the numbering, is per cycle: Regenerate restores a
    // full allowance, which is the whole point of tapping it. Counting
    // distinct attempt values rather than rows, because one attempt writes
    // one row per variant.
    const spentBeforeRun = counters?.spent ?? 0;
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - spentBeforeRun);

    let payload: Payload;
    try {
      payload = JSON.parse(row.payload) as Payload;
    } catch {
      log("error", "generation: unparseable payload", { queueId: row.queue_id });
      await insertGeneration(env.DB, { queueId: row.queue_id, cycle: row.regen_cycle, variant: "none", text: "", status: "rejected:payload", attempt }, now);
      continue;
    }

    // THE EXEMPLAR GATE. No owner exemplar for this archetype = no LLM call.
    //
    // Owner finals (p4-09) join the committed bank rather than replacing it.
    // Only the owner's REWRITES are promoted — see promotionStatement for why
    // feeding back our own accepted output is training on its own predictions.
    // They do NOT open the gate on their own either: a promoted final is
    // downstream of a generation a committed exemplar already licensed, so
    // gate-opening would let the loop bootstrap an archetype the owner never
    // wrote for.
    //
    // THE CAP IS RELATIVE, NOT ABSOLUTE, and that correction came from review.
    // A flat MAX_OWNER_FINALS=4 is not a cap where it matters: the committed
    // banks are CONGRESS_PTR 7, FILING_FORM4 5, FILING_8K 4, REGULATORY_NEWS
    // 3, and INSIDER_CLUSTER / HALT / MACRO_PRINT / RATE_DECISION 2 each.
    // Four promoted finals would make the bank majority-promoted for FIVE of
    // the eight archetypes — placed first, under a header saying they outrank
    // everything above on tone. HALT and MACRO_PRINT are among the highest
    // cadence, so the thinnest banks were the most exposed.
    //
    // Holding it to a strict minority of the committed count means the owner's
    // signed-off range always outweighs anything the loop added, by
    // construction rather than by a detector that has to notice.
    const committed = exemplars.filter((e) => e.archetype === archetypeId);
    const finalsAllowance = ownerFinalsAllowance(committed.length);
    const bank =
      committed.length === 0
        ? committed
        : [...(await ownerFinals(env.DB, archetypeId, finalsAllowance)), ...committed];
    if (bank.length === 0) {
      await insertGeneration(env.DB, { queueId: row.queue_id, cycle: row.regen_cycle, variant: "none", text: "", status: "skipped_no_exemplar", attempt }, now);
      log("info", "generation skipped: no owner exemplar for archetype", { queueId: row.queue_id, archetype: archetypeId });
      continue;
    }

    // The template fallback, budget-checked NOW under current rules. An
    // owner EDIT that no longer fits is never silently replaced (finding
    // #21b): the owner is told their edit is over budget before the
    // re-rendered template stands in for it.
    let fallback = row.edited_text ?? row.draft_text;
    let fallbackRerendered = false;
    if (!fitsInPost(fallback)) {
      if (row.edited_text) {
        await alertOwner(
          env,
          `⚠️ #${row.queue_id}: your edited text exceeds the 280 budget. Falling back to a re-rendered template draft; re-edit from the card if that's wrong.`,
          budget,
        );
      }
      const re = await renderForQueue(env, archetypeId, payload, `${archetypeId}:${row.item_id}`);
      if (re.ok) {
        fallback = re.text;
        fallbackRerendered = true;
        // Keep the rotation ledger truthful (finding #21a): the queue row now
        // effectively carries the re-rendered skeleton, so record it.
        await env.DB.prepare(`UPDATE queue SET skeleton_id = ?1, beat_id = ?2 WHERE id = ?3`)
          .bind(re.skeletonId, re.beatId, row.queue_id)
          .run()
          .catch(() => {});
        log("info", "generation: stale over-budget draft re-rendered", { queueId: row.queue_id });
      } else {
        await alertOwner(
          env,
          `⚠️ #${row.queue_id}: the approved draft exceeds the 280 budget and a re-render failed (${re.reason}). If generation also fails, this item will be HELD, not silently dropped.`,
          budget,
        );
      }
    }

    // GROUNDING (p4-01): the source document (ingest-captured or fetched once
    // and cached) plus our lake's context lines. Either may be absent —
    // generation proceeds on what exists, and the validator whitelist widens
    // to exactly what the prompt showed, nothing more.
    const hasCachedText = row.raw_text !== null && row.raw_text !== "";
    // Cached text costs no subrequest; a blocked host must not cost a budget
    // token for a fetch that will never happen (review finding).
    // A dedicated-capture source can never fetch here, so it must not spend a
    // token on a fetch that will not happen -- same reasoning as the
    // egress-blocked host check beside it.
    const canFetchSource =
      hasCachedText ||
      (!hasDedicatedCapture(row.source) && !isBlockedGroundingHost(row.source_url) && budget.take(1));
    const source = canFetchSource
      ? await fetchSourceText(env, { id: row.item_id, source: row.source, source_url: row.source_url, raw_text: row.raw_text, raw_meta: row.raw_meta }, now)
      : null;
    const context = await lakeContext(env.DB, { id: row.item_id, source: row.source, archetype: archetypeId }, payload);
    // PROVENANCE GATE before the whitelist widens. The SOURCE DOCUMENT is the
    // part that can be the wrong document (a mis-fetched EDGAR index page, an
    // exhibit instead of the filing); lake context is built from our own rows
    // keyed to this item, so it is trusted separately.
    const { provenance: sourceProvenance, licensed: licensedSource } = licensedGrounding(source, payload);
    if (source?.text && sourceProvenance.ok && sourceProvenance.reason === "no_usable_anchor") {
      // Fail-open is correct here (we cannot prove the text wrong with no
      // anchor to test), but it must not be SILENT: this is the shape the FDA
      // recall class hit, where the payload offers no anchor field AND the
      // source_url is always a landing page — i.e. the class whose document is
      // reliably wrong is the class the gate cannot see.
      log("warn", "grounding licensed WITHOUT provenance: payload offers no anchor field", {
        queueId: row.queue_id,
        source: row.source,
        archetype: archetypeId,
        chars: source.text.length,
      });
    }
    if (source?.text && !sourceProvenance.ok) {
      // The text still reaches the prompt — the model may make what it can of
      // it — but it does NOT license facts. Fail closed on the widening only.
      log("error", "grounding source failed provenance; not widening the whitelist", {
        queueId: row.queue_id,
        source: row.source,
        anchorsTried: sourceProvenance.anchorsTried,
        chars: source.text.length,
        reason: sourceProvenance.reason,
        host: source.host,
      });
    }
    const grounding = [licensedSource, ...context.lines].filter(Boolean).join("\n") || undefined;

    const valid = new Set<Variant>();
    const feedback: string[] = [];
    let sawApiError = false;

    for (let round = 0; round < 2 && attemptsLeft > round && valid.size < VARIANTS.length; round++) {
      if (!budget.take(1, { reserved: true })) break;
      let content: string;
      try {
        const prompt = buildPrompt(archetypeId, payload, bank, feedback, { source, contextLines: context.lines });
        content = await chatComplete(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ]);
      } catch (e) {
        if (e instanceof OpenRouterError && e.isAuthInvalid) {
          log("error", "openrouter key invalid; generation paused", { queueId: row.queue_id });
          // Once per 6h, not once per 5-minute tick (finding #32).
          if (!(await env.KV.get(KV_OPENROUTER_ALERTED))) {
            await env.KV.put(KV_OPENROUTER_ALERTED, "1", { expirationTtl: 6 * 3600 });
            await alertOwner(env, "⚠️ OpenRouter key is invalid or out of credit. Generation is paused; approved items keep their template drafts.", budget);
          }
          return;
        }
        // Transient failure (429/5xx/timeout): record a NON-terminal marker
        // and let the next 5-minute tick retry — natural backoff, no
        // permanent template downgrade (finding #9).
        sawApiError = true;
        log("error", "openrouter call failed", { queueId: row.queue_id, attempt, error: String(e) });
        await insertGeneration(env.DB, { queueId: row.queue_id, cycle: row.regen_cycle, variant: "none", text: "", status: "api_error", attempt }, now);
        attempt += 1;
        continue;
      }

      const variants = parseVariants(content);
      for (const v of VARIANTS) {
        if (valid.has(v)) continue;
        const text = variants[v];
        if (!text) {
          await insertGeneration(env.DB, { queueId: row.queue_id, cycle: row.regen_cycle, variant: v, text: "", status: "rejected:absent", attempt }, now);
          continue;
        }
        const issues: ValidationIssue[] = await validateVariant(env.DB, text, {
          queueId: row.queue_id,
          variant: v,
          archetype: archetypeId,
          payload,
          grounding,
          templateDraft: fallback,
          skeletonHash: skeletonHash(text),
          openerHash: openerHash(text),
          corpusPopulated,
        });
        const status = issues.length === 0 ? "valid" : `rejected:${issues[0]!.rule}`;
        await insertGeneration(env.DB, { queueId: row.queue_id, cycle: row.regen_cycle, variant: v, text, status, attempt }, now);
        if (issues.length === 0) {
          valid.add(v);
        } else {
          feedback.push(`${v}: ${issues.map((i) => i.detail).join("; ")}`);
          log("info", "variant rejected", { queueId: row.queue_id, variant: v, attempt, issues: issues.map((i) => i.rule).join(",") });
        }
      }
      attempt += 1;
    }

    if (valid.size > 0) continue; // at least one variant made it; the card has options

    // PER CYCLE, not per row (p5-01). This guard asks "does this row still
    // have retries left", and once the budget became per-cycle the global
    // MAX(attempt) stopped answering that question: after one Regenerate it
    // already exceeds MAX_ATTEMPTS, the condition is false forever, and the
    // FIRST transient 429/5xx in the new cycle writes a terminal template row
    // instead of retrying. That is finding #9's permanent-downgrade
    // regression, reintroduced for every regenerated row and silent when it
    // happens.
    if (sawApiError && spentBeforeRun + 2 < MAX_ATTEMPTS) {
      // Pure transient failure with retries left: leave NO terminal row so
      // the next tick picks this row up again.
      continue;
    }

    // Every attempt is spent (or produced only rejections). Fall back to the
    // template — but the fallback itself must clear the register guard: it
    // may be hand-typed edited_text approved before the park, and the old
    // publish-time gate is exactly what this reinstates (finding #12).
    let finalFallback = fallback;
    let fallbackIssues = checkRegister(finalFallback, archetypeId);
    if ((fallbackIssues.length > 0 || !fitsInPost(finalFallback)) && !fallbackRerendered) {
      const re = await renderForQueue(env, archetypeId, payload, `${archetypeId}:${row.item_id}`);
      if (re.ok) {
        finalFallback = re.text;
        fallbackIssues = checkRegister(finalFallback, archetypeId);
        await env.DB.prepare(`UPDATE queue SET skeleton_id = ?1, beat_id = ?2 WHERE id = ?3`)
          .bind(re.skeletonId, re.beatId, row.queue_id)
          .run()
          .catch(() => {});
      }
    }
    if (fallbackIssues.length > 0 || !fitsInPost(finalFallback)) {
      // The loud terminal case: nothing publishable exists for this row.
      await insertGeneration(env.DB, { queueId: row.queue_id, cycle: row.regen_cycle, variant: "none", text: "", status: "fallback_blocked", attempt }, now);
      await alertOwner(
        env,
        `🛑 #${row.queue_id}: generation failed AND the template fallback fails the register (${fallbackIssues.map((i) => i.rule).join(",") || "over budget"}). The item is held for your edit; nothing copy-ready exists.`,
        budget,
      );
      continue;
    }
    await insertGeneration(env.DB, { queueId: row.queue_id, cycle: row.regen_cycle, variant: "none", text: finalFallback, status: "fallback_template", attempt }, now);
    log("warn", "generation fell back to template for queue row", { queueId: row.queue_id });
  }
}
