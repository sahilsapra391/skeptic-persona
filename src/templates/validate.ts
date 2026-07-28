import type { ArchetypeId } from "./types";
import { ARCHETYPES } from "./archetypes";
import { POST_TEXT_LIMIT, weightedLength } from "./length";

// Register checks for text that BYPASSES the engine — i.e. anything the owner
// hand-writes through the Telegram edit flow. The engine guarantees doctrine
// by construction; an edited draft has no such guarantee, so it gets the same
// register rules applied after the fact (persona.md §6, §11).

/**
 * Advice detection, deliberately narrow.
 *
 * persona.md section 6 bans ADVICE: telling the reader what to do, or
 * predicting direction. It does not ban the vocabulary of markets. A blunt
 * word list produced three false positives in a row and zero true ones:
 * "filed notice to sell" (Form 144), "coming up short" (Treasury), and
 * "leveraged funds net short" (CFTC) are all factual descriptions of a
 * parsed record, and refusing them makes the wire less accurate rather than
 * safer.
 *
 * So these match advice CONSTRUCTIONS, not bare words.
 */
const ADVICE_PATTERNS: readonly RegExp[] = [
  // Directional calls and targets, banned outright.
  /\b(bullish|bearish)\b/i,
  /\bprice target\b/i,
  /\b(to the moon|load up|buy the dip|dip buy)\b/i,
  // Imperatives aimed at the reader. The object matters: "Short interest
  // rose" opens a sentence with the same word and is a plain fact, so the
  // pattern requires something a command would actually take.
  /(^|[.!?]\s+)(buy|sell|short|avoid)\s+(this|that|these|those|it|now|here|the\s+dip|\$[A-Z])/i,
  /\b(you|we)\s+(should|must|need to)\s+(buy|sell|short|avoid|own|hold)\b/i,
  /\b(should|must)\s+(buy|sell|short|avoid)\b/i,
  /\bworth (buying|selling|shorting|owning)\b/i,
  // Forecasts.
  /\b(will|going to)\s+(rise|fall|rally|crash|soar|plunge)\b/i,
  /\bexpect\s+\S+\s+to\s+(rise|fall|rally|crash)\b/i,
];

export interface RegisterIssue {
  readonly rule: string;
  readonly detail: string;
}

export function checkRegister(text: string, archetype?: ArchetypeId): RegisterIssue[] {
  const issues: RegisterIssue[] = [];
  if (text.trim() === "") issues.push({ rule: "empty", detail: "post is empty" });
  const weighted = weightedLength(text);
  if (weighted > POST_TEXT_LIMIT) {
    // Weighted, not String.length: X bills emoji and CJK at 2 and any URL at
    // 23. Reporting the weighted figure so a rejection message matches what
    // the compose box would say.
    issues.push({ rule: "length", detail: `${weighted} weighted chars, limit ${POST_TEXT_LIMIT}` });
  }
  if (text.includes("—")) issues.push({ rule: "em_dash", detail: "em-dashes are banned in post copy" });
  if (text.includes("#")) issues.push({ rule: "hashtag", detail: "no hashtags" });
  if (text.trimEnd().endsWith("?")) issues.push({ rule: "question", detail: "no engagement-bait questions" });
  if (ADVICE_PATTERNS.some((re) => re.test(text))) {
    issues.push({ rule: "advice", detail: "advice language" });
  }
  const attribution = archetype ? ARCHETYPES[archetype]?.attribution : undefined;
  if (attribution && !text.includes(attribution)) {
    issues.push({ rule: "attribution", detail: `missing "${attribution}"` });
  }
  return issues;
}
