import type { ArchetypeId, Payload } from "./types";
import { resolveAttribution } from "./render";
import { ARCHETYPES } from "./archetypes";
import { POST_TEXT_LIMIT, weightedLength } from "./length";
import {
  ALL_ATTRIBUTION_FORMS,
  acceptedForms,
  actorsFor,
  factBlockOf,
  inActorPosition,
  namesIn,
  withoutPerPhrases,
} from "./attribution";

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

// ---------------------------------------------------------------------------
// THE ATTRIBUTION RULE (owner ruling 2026-08-06)
//
// Attribution is satisfied when the publishing source IS the named actor of
// the fact line ("The FTC just sued...", "A company just told the SEC..."). A
// trailing "per X" is required only when source and actor differ. Restating
// both is redundancy and is flagged.
//
// The exemplar that forced this: the desk's own REGULATORY_NEWS voice model
// reads "The FTC just sued to block a merger announced eleven months ago."
// Under the pre-amendment rule it failed for missing "per FTC" — a citation
// the sentence already carries in its subject.
// ---------------------------------------------------------------------------

/**
 * The registered attribution form each "per ..." phrase in the text resolves
 * to, longest match wins.
 *
 * Longest-match is not a nicety. "per SEC" is a prefix of "per SEC Form 4",
 * so a substring test would read a correct Form 4 citation as ALSO carrying a
 * bare "per SEC" and report the draft as citing a source it never named.
 */
function citedForms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bper\s+[^.,\n]*/gi)) {
    let best: string | null = null;
    for (const f of ALL_ATTRIBUTION_FORMS) {
      if (m[0].toLowerCase().startsWith(f.toLowerCase()) && (best === null || f.length > best.length)) best = f;
    }
    if (best !== null) out.push(best);
  }
  return out;
}

export interface AttributionVerdict {
  /** Accepted "per X" forms actually present in the text. */
  readonly trailing: readonly string[];
  /**
   * Registered citations present that are NOT this item's source. Embedded
   * attribution never excuses one: a fact line may carry its citation in its
   * subject, but it may not ALSO name a different agency as the record.
   */
  readonly foreign: readonly string[];
  /** Source names carried in the fact block outside any "per" phrase. */
  readonly embedded: readonly string[];
  /** Embedded names that appear as the doer of the fact. */
  readonly asActor: readonly string[];
  /** Every accepted trailing form for this archetype/payload. */
  readonly accepted: readonly string[];
  /** Every name whose presence would count as embedded attribution. */
  readonly actors: readonly string[];
}

/**
 * Resolve what attribution a text carries for a given archetype. Exported so
 * the exemplar tests judge the pack by the SAME rule the pipeline judges
 * output by, rather than by a hand-copied regex that drifts.
 */
export function attributionVerdict(text: string, archetype: ArchetypeId, payload?: Payload): AttributionVerdict {
  const arch = ARCHETYPES[archetype];
  const exact = payload ? resolveAttribution(arch, payload) : null;
  const displays =
    exact !== null
      ? [exact]
      : typeof arch.attribution === "string"
        ? [arch.attribution]
        : Object.values(arch.attribution.map);
  const accepted = [...new Set(displays.flatMap((d) => acceptedForms(d)))];
  const actors = [...new Set(displays.flatMap((d) => actorsFor(d)))];
  const scrubbed = withoutPerPhrases(factBlockOf(text));
  const cited = citedForms(text);
  return {
    trailing: [...new Set(cited.filter((c) => accepted.includes(c)))],
    foreign: [...new Set(cited.filter((c) => !accepted.includes(c)))],
    embedded: namesIn(scrubbed, actors),
    asActor: inActorPosition(scrubbed, actors),
    accepted,
    actors,
  };
}

export function checkRegister(text: string, archetype?: ArchetypeId, payload?: Payload): RegisterIssue[] {
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
  if (archetype !== undefined && ARCHETYPES[archetype] !== undefined) {
    // With the item's payload we check the ONE citation correct for THIS
    // item. Hand-edited text is the only path that bypasses the renderer, so
    // without this a House draft edited to say "per Senate eFD" would pass.
    // (Aliases widen which SPELLING of the right source is accepted; they
    // never widen WHICH source. The wrong-chamber kill-test still fails,
    // because the Senate forms are not in the House entry.)
    const v = attributionVerdict(text, archetype, payload);
    if (v.foreign.length > 0) {
      // A CROSS-SOURCE CITATION ALWAYS DIES, embedded attribution or not.
      // Caught by the CFTC kill-test: "CFTC orders a $35,000 payment, per
      // SEC." satisfies the embedded rule through its own subject, and the
      // first cut of the amendment let the wrong agency ride along unchecked.
      issues.push({
        rule: "attribution",
        detail: `cites ${v.foreign.map((a) => `"${a}"`).join(", ")}; this item's record is ${v.accepted.map((a) => `"${a}"`).join(" or ")}`,
      });
    } else if (v.trailing.length === 0 && v.embedded.length === 0) {
      const embeddedHint = v.actors.length > 0 ? `, and the fact block names none of ${v.actors.map((a) => `"${a}"`).join(", ")}` : "";
      issues.push({
        rule: "attribution",
        detail: `missing ${v.accepted.map((a) => `"${a}"`).join(" or ")}${embeddedHint}`,
      });
    } else if (v.trailing.length > 0 && v.asActor.length > 0) {
      issues.push({
        rule: "attribution_redundant",
        detail: `"${v.asActor[0]}" is the actor of the fact and the citation both; drop the trailing ${v.trailing.map((a) => `"${a}"`).join(" / ")}`,
      });
    }
  }
  return issues;
}
