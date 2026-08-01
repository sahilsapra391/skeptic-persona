// Shape fingerprints and n-gram hashing for the echo/collision checks.
//
// Everything here is pure and dependency-free, and scripts/build-echo-hashes.mjs
// inlines the SAME hashing (documented there) so the offline corpus hashes and
// the runtime draft hashes can never drift apart. Change one, change both —
// there is a test pinning known hash values to catch a one-sided edit.

/**
 * Mask a post to its skeleton: content tokens out, shape left behind.
 * Deliberately the same masking family as the corpus study
 * (docs/verification/2026-07-28-competitor-topic-engagement.md), which is what
 * makes "19,184 distinct skeletons in 19,518 posts" comparable to what this
 * produces at runtime.
 *
 * Two posts with the same skeleton read as the same post wearing different
 * numbers — which is the repetition signal the ban taught us platforms watch.
 */
export function maskSkeleton(text: string): string {
  let s = text.normalize("NFC");
  s = s.replace(/https?:\/\/\S+/gi, "<URL>");
  s = s.replace(/\$[A-Z]{1,5}\b/g, "<TICKER>");
  // Numbers before entities, so "$1,000,001" doesn't half-match.
  s = s.replace(/\$?\d[\d,]*\.?\d*\s*(%|bps|billion|million|thousand|[MKB]\b)?/gi, "<NUM>");
  // Multi-word proper nouns (people, companies), then remaining ALL-CAPS runs.
  s = s.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, "<ENTITY>");
  s = s.replace(/\b[A-Z]{2,}\b/g, "<CAPS>");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/(<NUM>[\s,]*)+/g, "<NUM> ");
  return s;
}

/**
 * ACCEPTED FALSE-REJECTION RATE (measured, 2026-08-01).
 *
 * 32-bit FNV-1a over a loaded set of 726,579 hashes occupies 1.692e-4 of the
 * space. A draft carries 16-61 distinct 8-grams (median 31 across the owner's
 * exemplars), so the chance of at least one PURE collision is:
 *
 *     16 grams -> 0.270%      31 grams -> 0.523%      61 grams -> 1.027%
 *
 * About one draft in 200 at the median is rejected for echoing a competitor
 * post it never echoed. Recorded rather than hidden because the rejection
 * reason reads as legitimate (`rejected:corpus_echo`), so the cost is
 * invisible without this note. The consequence is bounded: a rejected variant
 * regenerates once and then falls back to the template, so a false hit costs
 * one extra LLM call, never a wrong post.
 *
 * WHY NOT WIDEN TO 64-BIT TODAY: the stored hashes ARE this function's output.
 * Changing it silently invalidates all 726,579 rows — every lookup would miss,
 * and the check would return to being a no-op that reports "no match", which
 * is precisely the failure that hid it for four days. Widening is therefore a
 * COORDINATED change: ship the new hash and reload the table in the same
 * operation, then verify with a live probe (a known corpus 8-gram must hit, an
 * owner-exemplar 8-gram must not). Do not do one without the other.
 */
/** FNV-1a 32-bit over UTF-16 code units, hex. Fast, sync, good enough for
 *  collision *detection* (we compare equality, we don't need crypto). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function skeletonHash(text: string): string {
  return fnv1a(maskSkeleton(text));
}

/** Words that don't distinguish one opener from another. */
const OPENER_STOPWORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "per"]);

/**
 * Hash of the first four content-bearing tokens. Consecutive posts that open
 * with the same four words read as a template even when the rest diverges.
 */
export function openerHash(text: string): string {
  const words = (text.toLowerCase().match(/[a-z0-9$%']+/g) ?? []).filter((w) => !OPENER_STOPWORDS.has(w));
  return fnv1a(words.slice(0, 4).join(" "));
}

/**
 * Salted 8-gram hashes over lowercased word tokens.
 *
 * The salt is a committed constant, not a secret: its job is to make the
 * stored corpus hashes useless for any purpose EXCEPT this membership test
 * (you cannot look a hash up anywhere else), not to survive an adversary who
 * has both this code and the corpus — that adversary already has the corpus.
 */
export const NGRAM_SALT = "skeptic-echo-v1";
export const NGRAM_N = 8;

export function ngramHashes(text: string, n: number = NGRAM_N, salt: string = NGRAM_SALT): Set<string> {
  const words = text.toLowerCase().normalize("NFC").match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(fnv1a(`${salt} ${words.slice(i, i + n).join(" ")}`));
  }
  return out;
}

/** Shared 8-grams between two texts (raw words, unsalted comparison —
 *  used draft-vs-template where both sides are in hand). */
export function sharedNgrams(a: string, b: string, n: number = NGRAM_N): string[] {
  const words = (t: string): string[] => t.toLowerCase().normalize("NFC").match(/[a-z0-9']+/g) ?? [];
  const grams = (w: string[]): Set<string> => {
    const g = new Set<string>();
    for (let i = 0; i + n <= w.length; i++) g.add(w.slice(i, i + n).join(" "));
    return g;
  };
  const ga = grams(words(a));
  return [...grams(words(b))].filter((g) => ga.has(g));
}
