import type { Payload } from "../templates/types";
import type { ArchetypeId } from "../templates/types";
import { checkRegister } from "../templates/validate";
import { POST_TEXT_LIMIT, weightedLength } from "../templates/length";
import { ngramHashes, sharedNgrams } from "./echo";

// Generated-draft validation (docs/p2r-plan.md Part D).
//
// GROUP 1 is the no-fabrication floor and fails CLOSED: any doubt kills the
// variant. It replaces, for LLM text, the guarantee templates gave by
// construction — a slot cannot emit a number that isn't in the payload, so a
// validator must prove the same about prose.
//
// GROUP 2 is the commentary contract: a variant that reads like a template,
// echoes the corpus, hedges, or repeats a recent shape is rejected exactly
// like a fabricated number, per the owner's contract ("if a variant reads
// like a template, the validator should reject it as much as it rejects a
// fabricated number").
//
// The never-list check is checkRegister, REUSED not rewritten: it was
// recalibrated 2026-07-27 after bare-word matching produced 3 false positives
// and 0 true ones. Every pattern added here follows the same law — match
// CONSTRUCTIONS, never bare words — and ships with the known false-positive
// corpus as test fixtures.

export interface ValidationIssue {
  readonly rule: string;
  readonly detail: string;
}

export type Variant = "dry" | "sharp" | "commentary";

// ---------------------------------------------------------------------------
// GROUP 1 — the no-fabrication floor
// ---------------------------------------------------------------------------

const SCALE_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(billion|bn|B)\b/i, 1e9],
  [/\b(million|mm|M)\b/i, 1e6],
  [/\b(thousand|K)\b/i, 1e3],
];

function canon(n: number): string {
  // One canonical spelling per value; tolerate float noise from scale math.
  return Number(n.toPrecision(12)).toString();
}

/**
 * Every numeric value derivable from the payload, in canonical form.
 * Includes scale variants both ways (1200000 -> 1.2, 1.2M -> 1200000) so
 * "the model restated a payload number at a different scale" stays legal
 * while "the model produced a number from nowhere" cannot.
 */
export function allowedNumbers(payload: Payload): Set<string> {
  const allowed = new Set<string>();
  const addWithScales = (n: number): void => {
    if (!Number.isFinite(n)) return;
    allowed.add(canon(n));
    if (Math.abs(n) >= 1000) for (const [, f] of SCALE_WORDS) allowed.add(canon(n / f));
    for (const [, f] of SCALE_WORDS) allowed.add(canon(n * f));
    allowed.add(canon(Math.abs(n)));
  };
  const walk = (v: unknown): void => {
    if (typeof v === "number") addWithScales(v);
    else if (typeof v === "string") {
      // Pull every number out of payload strings: dates ("2026-06-03" ->
      // 2026, 6, 3), bands ("$1,000,001 - $5,000,000"), times, CIKs.
      for (const m of v.matchAll(/\d[\d,]*\.?\d*/g)) {
        addWithScales(Number(m[0].replace(/,/g, "")));
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(payload);
  return allowed;
}

/** Numeric tokens in a draft, with the scale word (if adjacent) applied. */
export function draftNumbers(text: string): Array<{ raw: string; value: number }> {
  const out: Array<{ raw: string; value: number }> = [];
  // Number plus optional attached scale suffix or following scale word.
  for (const m of text.matchAll(/\$?(\d[\d,]*\.?\d*)\s*(%|bps|billion|bn|million|mm|thousand|[MKB]\b)?/g)) {
    const base = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    let value = base;
    const suffix = m[2];
    if (suffix && !/^(%|bps)$/i.test(suffix)) {
      for (const [re, f] of SCALE_WORDS) if (re.test(suffix)) value = base * f;
    }
    out.push({ raw: m[0].trim(), value });
  }
  return out;
}

export function numberCheck(text: string, payload: Payload): ValidationIssue[] {
  const allowed = allowedNumbers(payload);
  const payloadJson = JSON.stringify(payload);
  const issues: ValidationIssue[] = [];
  for (const { raw, value } of draftNumbers(text)) {
    if (allowed.has(canon(value))) continue;
    // Verbatim fallback: "19:50" or "2026-06-03" style tokens ride whole.
    const bare = raw.replace(/[$,]/g, "");
    if (bare !== "" && payloadJson.includes(bare)) continue;
    issues.push({ rule: "number", detail: `"${raw}" does not appear in the payload` });
  }
  return issues;
}

/** Words that look like entities but are the wire's own furniture. */
const ENTITY_WHITELIST = new Set([
  // attribution + regulator vocabulary
  "SEC", "EDGAR", "BLS", "FDA", "CFTC", "FTC", "FCA", "ECB", "FOMC", "DOJ",
  "NYSE", "OTC", "IPO", "ET", "UTC", "CIK", "CEO", "CFO", "COO", "CTO", "GDP", "CPI", "PPI", "PCE",
  "LUDP", "LUDS", "USD", "EUR", "GBP",
  // form vocabulary
  "PTR", "EFD",
  // months + days (dates render as words)
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST",
  "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
  "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY",
]);

/**
 * Every ticker, ALL-CAPS token, and multi-word proper noun in the draft must
 * exist in the payload. Single capitalized words are NOT checked — sentence
 * starts make them hopeless — which is a known, accepted gap: a fabricated
 * single-word name sneaks past this check but not past the owner's eyes, and
 * the number/attribution checks bound the damage.
 */
export function entityCheck(text: string, payload: Payload): ValidationIssue[] {
  const payloadJson = JSON.stringify(payload).toLowerCase();
  const issues: ValidationIssue[] = [];
  const flag = (kind: string, token: string): void => {
    if (!payloadJson.includes(token.toLowerCase())) {
      issues.push({ rule: "entity", detail: `${kind} "${token}" does not appear in the payload` });
    }
  };
  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) flag("ticker", m[1]!);
  for (const m of text.matchAll(/\b([A-Z]{2,})\b/g)) {
    if (!ENTITY_WHITELIST.has(m[1]!)) flag("all-caps token", m[1]!);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
    // "per Senate eFD" style attribution is furniture, not an entity claim.
    if (/^(Senate|Federal Register|Form|Schedule)\b/.test(m[1]!)) continue;
    flag("name", m[1]!);
  }
  return issues;
}

/**
 * Structural law (persona.md section 3): fact block first, carrying the
 * attribution; at most ONE further segment (the beat / the take), separated
 * by a blank line; never blended.
 */
export function structuralCheck(text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const segments = text.split(/\n\n+/);
  if (segments.length > 2) {
    issues.push({ rule: "structure", detail: `${segments.length} segments; fact block plus at most one take` });
  }
  if (!/\bper .+/.test(segments[0] ?? "")) {
    issues.push({ rule: "structure", detail: "attribution must ride the fact block, not the take" });
  }
  return issues;
}

export function lengthCheck(text: string, variant: Variant): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const w = weightedLength(text);
  if (w > POST_TEXT_LIMIT) issues.push({ rule: "length", detail: `${w} weighted chars, limit ${POST_TEXT_LIMIT}` });
  // The commentary contract's floor: an "opinion piece" of 90 chars is a
  // wire post that lost its way. dry/sharp have no floor by design.
  if (variant === "commentary" && w < 200) {
    issues.push({ rule: "length", detail: `commentary is ${w} weighted chars; contract is 200-280` });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// GROUP 2 — the commentary contract
// ---------------------------------------------------------------------------

/**
 * Hedge CONSTRUCTIONS. Bare "may"/"could" are legal English and legal quotes
 * of filing language ("prior financials may not be relied upon" is the
 * record's own sentence). What's banned is the desk hedging its OWN claim.
 */
const HEDGE_PATTERNS: readonly RegExp[] = [
  /\b(?:this|that|it|which)\s+(?:may|might|could)\s+(?:suggest|indicate|signal|mean|imply)\b/i,
  /\b(?:appears?|seems?)\s+to\b/i,
  /\b(?:arguably|perhaps|possibly|presumably|likely just|probably)\b/i,
  /\bit(?:'s| is) (?:worth noting|notable|interesting) (?:that\b|how\b)/i,
  /\bsome (?:say|argue|believe|think)\b/i,
  /\btime will tell\b/i,
  /\bremains to be seen\b/i,
  /\bmake of that what you will\b/i,
];

export function hedgeCheck(text: string): ValidationIssue[] {
  const hit = HEDGE_PATTERNS.find((re) => re.test(text));
  return hit ? [{ rule: "hedge", detail: `hedge construction: ${String(hit.exec(text)?.[0])}` }] : [];
}

/**
 * Bot cadence: N sentences of near-identical length read as generated text
 * even when each sentence is fine alone. Also the triple anaphora ("Not X.
 * Not Y. Not Z.") — the single most recognizable LLM tic.
 */
export function cadenceCheck(text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sentences = text.split(/[.!?]\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (sentences.length >= 3) {
    const lens = sentences.map((s) => s.length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (mean > 20 && sd / mean < 0.12) {
      issues.push({ rule: "cadence", detail: "uniform sentence lengths read as generated text" });
    }
  }
  const anaphora = /\b(\w+)\s+\w+[^.!?\n]*[.!?]\s+\1\s+\w+[^.!?\n]*[.!?]\s+\1\s+\w+/i;
  const m = anaphora.exec(text);
  if (m && !/^(the|a|an|it|per)$/i.test(m[1] ?? "")) {
    issues.push({ rule: "cadence", detail: `triple anaphora on "${m[1]}"` });
  }
  return issues;
}

/**
 * Template echo (commentary only): commentary sharing an 8-gram with the
 * template draft for the same item is the template wearing a coat of paint.
 */
export function templateEchoCheck(text: string, templateDraft: string): ValidationIssue[] {
  const shared = sharedNgrams(templateDraft, text);
  return shared.length > 0
    ? [{ rule: "template_echo", detail: `shares an 8-gram with the template draft: "${shared[0]}"` }]
    : [];
}

/** Corpus echo: any salted 8-gram of the draft present in echo_ngrams. */
export async function corpusEchoCheck(
  db: D1Database,
  text: string,
): Promise<{ issues: ValidationIssue[]; corpusEmpty: boolean }> {
  const hashes = [...ngramHashes(text)];
  if (hashes.length === 0) return { issues: [], corpusEmpty: false };
  const any = await db.prepare(`SELECT COUNT(*) AS n FROM echo_ngrams`).first<{ n: number }>();
  if (!any || any.n === 0) return { issues: [], corpusEmpty: true }; // fail-open, logged by the caller
  const placeholders = hashes.map((_, i) => `?${i + 1}`).join(",");
  const hit = await db
    .prepare(`SELECT hash FROM echo_ngrams WHERE hash IN (${placeholders}) LIMIT 1`)
    .bind(...hashes)
    .first<{ hash: string }>();
  return {
    issues: hit ? [{ rule: "corpus_echo", detail: "an 8-gram matches the studied corpus" }] : [],
    corpusEmpty: false,
  };
}

/** Recent-shape collisions, CROSS-archetype by design: 18 structurally
 *  identical posts across five archetypes is the pattern that got the
 *  Threads account banned; a same-archetype check would have passed it. */
export async function collisionCheck(
  db: D1Database,
  skeletonHash: string,
  openerHash: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const recentSkeletons = await db
    .prepare(`SELECT skeleton_hash FROM generations WHERE status = 'valid' ORDER BY id DESC LIMIT 40`)
    .all<{ skeleton_hash: string }>();
  if (recentSkeletons.results.some((r) => r.skeleton_hash === skeletonHash)) {
    issues.push({ rule: "skeleton_collision", detail: "shape matches one of the last 40 valid variants" });
  }
  const recentOpeners = await db
    .prepare(`SELECT opener_hash FROM generations WHERE status = 'valid' ORDER BY id DESC LIMIT 20`)
    .all<{ opener_hash: string }>();
  if (recentOpeners.results.some((r) => r.opener_hash === openerHash)) {
    issues.push({ rule: "opener_collision", detail: "opener matches one of the last 20 valid variants" });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  readonly variant: Variant;
  readonly archetype: ArchetypeId;
  readonly payload: Payload;
  readonly templateDraft: string;
  readonly skeletonHash: string;
  readonly openerHash: string;
}

export interface ValidateResult {
  readonly issues: ValidationIssue[];
  /** True when echo_ngrams is empty — the caller logs it once per run. */
  readonly corpusEmpty: boolean;
}

/** The full gate a variant must clear before the owner sees it. */
export async function validateVariant(db: D1Database, text: string, opts: ValidateOptions): Promise<ValidateResult> {
  const issues: ValidationIssue[] = [
    // Group 1 — the floor.
    ...numberCheck(text, opts.payload),
    ...entityCheck(text, opts.payload),
    ...structuralCheck(text),
    ...checkRegister(text, opts.archetype),
    ...lengthCheck(text, opts.variant),
    // Group 2 — the contract (sync parts).
    ...hedgeCheck(text),
    ...cadenceCheck(text),
  ];
  if (opts.variant === "commentary") issues.push(...templateEchoCheck(text, opts.templateDraft));
  issues.push(...(await collisionCheck(db, opts.skeletonHash, opts.openerHash)));
  const corpus = await corpusEchoCheck(db, text);
  issues.push(...corpus.issues);
  return { issues, corpusEmpty: corpus.corpusEmpty };
}
