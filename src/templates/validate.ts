import type { ArchetypeId } from "./types";
import { ARCHETYPES } from "./archetypes";
import { THREADS_TEXT_LIMIT } from "./render";

// Register checks for text that BYPASSES the engine — i.e. anything the owner
// hand-writes through the Telegram edit flow. The engine guarantees doctrine
// by construction; an edited draft has no such guarantee, so it gets the same
// register rules applied after the fact (persona.md §6, §11).

export interface RegisterIssue {
  readonly rule: string;
  readonly detail: string;
}

export function checkRegister(text: string, archetype?: ArchetypeId): RegisterIssue[] {
  const issues: RegisterIssue[] = [];
  if (text.trim() === "") issues.push({ rule: "empty", detail: "post is empty" });
  if (text.length > THREADS_TEXT_LIMIT) {
    issues.push({ rule: "length", detail: `${text.length} chars, limit ${THREADS_TEXT_LIMIT}` });
  }
  if (text.includes("—")) issues.push({ rule: "em_dash", detail: "em-dashes are banned in post copy" });
  if (text.includes("#")) issues.push({ rule: "hashtag", detail: "no hashtags" });
  if (text.trimEnd().endsWith("?")) issues.push({ rule: "question", detail: "no engagement-bait questions" });
  if (/\b(buy|sell|short|avoid|bullish|bearish|price target)\b/i.test(text)) {
    // Note: a fact line may legitimately contain "bought"/"sold"; the ban is
    // on the imperative/directional register, so this matches whole words only.
    issues.push({ rule: "advice", detail: "advice language" });
  }
  const attribution = archetype ? ARCHETYPES[archetype]?.attribution : undefined;
  if (attribution && !text.includes(attribution)) {
    issues.push({ rule: "attribution", detail: `missing "${attribution}"` });
  }
  return issues;
}
