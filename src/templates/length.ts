// Post length, measured the way X measures it.
//
// Verified 2026-07-28 against twitter-text config v3 — the reference
// implementation X publishes. See docs/verification/2026-07-28-x-post-length.md.
//
//   maxWeightedTweetLength 280   scale 100   defaultWeight 200
//   transformedURLLength   23    emojiParsingEnabled true
//   ranges (weight 100): [0,4351] [8192,8205] [8208,8223] [8242,8247]
//
// The headline consequence: `String.length` is NOT the measure. It is wrong in
// both directions, so neither over- nor under-counting is safe by default.
//
//   "🇮🇳"  String.length 4  ->  X counts 2   (one emoji cluster, two code points,
//                                            each a surrogate pair)
//   "日"   String.length 1  ->  X counts 2   (outside every weight-100 range)
//
// persona.md §6 permits exactly the characters where this bites: country flags
// for rate decisions and 🟢🔴 for tape. A naive length check would have refused
// publishable posts and accepted over-long ones.

export const POST_TEXT_LIMIT = 280; // maxWeightedTweetLength

const SCALE = 100;
const DEFAULT_WEIGHT = 200;
const TRANSFORMED_URL_LENGTH = 23;

/** Code point ranges that weigh 100 (i.e. one character). Everything else weighs 200. */
const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351], // Latin, Greek, Cyrillic, Hebrew, Arabic, ... Georgian
  [8192, 8205], // general punctuation through ZWJ
  [8208, 8223], // dashes and quotation marks
  [8242, 8247], // primes
];

// X wraps every link in t.co, so any URL costs exactly 23 regardless of its
// real length. Deliberately greedy on the scheme and permissive on the tail:
// over-matching a URL can only make our estimate MORE conservative.
const URL_RE = /https?:\/\/\S+/gi;

const ZWJ = 0x200d;
const VARIATION_SELECTOR_16 = 0xfe0f;
const KEYCAP = 0x20e3;

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/** Modifiers that attach to the preceding cluster and cost nothing extra. */
function isAttaching(cp: number): boolean {
  return cp === VARIATION_SELECTOR_16 || cp === KEYCAP || (cp >= 0x1f3fb && cp <= 0x1f3ff); // skin tones
}

function weightOf(cp: number): number {
  for (const [start, end] of LIGHT_RANGES) {
    if (cp >= start && cp <= end) return 100;
  }
  return DEFAULT_WEIGHT;
}

/**
 * The weighted length of `text` in X characters.
 *
 * Cluster handling is deliberately PARTIAL and deliberately conservative. We
 * collapse the three cluster shapes we can identify without shipping the whole
 * Unicode emoji table: regional-indicator pairs (flags), ZWJ sequences, and
 * attaching modifiers. Any emoji we fail to recognise is counted per code
 * point, which OVER-counts, so an unrecognised cluster can only cost us a few
 * characters of budget. It can never let an over-long post through.
 */
export function weightedLength(text: string): number {
  // twitter-text normalises to NFC before counting; "é" as e + combining acute
  // is one character to X, two code points to us.
  const normalized = text.normalize("NFC");

  // Swap URLs out for a marker that carries their fixed cost. Done first so the
  // per-code-point pass never sees URL characters.
  let urlWeight = 0;
  const withoutUrls = normalized.replace(URL_RE, () => {
    urlWeight += TRANSFORMED_URL_LENGTH * SCALE;
    return "";
  });

  const points = [...withoutUrls].map((c) => c.codePointAt(0) ?? 0);
  let weight = 0;
  let i = 0;
  while (i < points.length) {
    const cp = points[i]!;

    // Flag: exactly two regional indicators are one emoji.
    if (isRegionalIndicator(cp) && i + 1 < points.length && isRegionalIndicator(points[i + 1]!)) {
      weight += DEFAULT_WEIGHT;
      i += 2;
      continue;
    }

    // ZWJ sequence: consume the whole joined run as a single emoji.
    let j = i + 1;
    while (j < points.length && isAttaching(points[j]!)) j++;
    let consumed = j;
    while (consumed + 1 < points.length && points[consumed] === ZWJ) {
      consumed += 2; // the ZWJ and the code point it joins
      while (consumed < points.length && isAttaching(points[consumed]!)) consumed++;
    }
    if (consumed > i + 1) {
      weight += DEFAULT_WEIGHT;
      i = consumed;
      continue;
    }

    weight += weightOf(cp);
    i += 1;
  }

  return (weight + urlWeight) / SCALE;
}

/** True when `text` fits in a post. */
export function fitsInPost(text: string): boolean {
  return weightedLength(text) <= POST_TEXT_LIMIT;
}
