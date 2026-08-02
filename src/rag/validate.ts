import type { Payload } from "../templates/types";
import type { ArchetypeId } from "../templates/types";
import { ARCHETYPES } from "../templates/archetypes";
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
// like a fabricated number.
//
// HARDENED 2026-07-28 after an adversarial bypass hunt (45-agent review)
// broke the first version six ways. The holes and their closures, kept here
// because each is a lesson in how "obviously safe" allowances compose into
// fabrication licenses:
//
//  1. Unconditional scale-up (n*1e3/1e6/1e9 for every payload number) let
//     lagDays 45 legitimize "45,000 shares" and "$45 billion". Scale-up is
//     GONE: draftNumbers already resolves "1.2M" to 1200000, so the allowed
//     set never needs inflated variants; only the guarded scale-DOWN stays
//     (payload 1200000 licenses a bare "1.2"; nothing licenses upward).
//  2. Raw substring fallback (payloadJson.includes) let "$100,000" pass as a
//     prefix of 1000001. The verbatim path now requires a non-digit char in
//     the token (times, codes like "8-K") AND digit-boundary matching.
//  3. Spelled-out numbers ("nine million", "forty-six") were invisible to
//     the digit regex. A word-number parser now evaluates them into the same
//     membership check; relative quantities ("double", "half of the") are
//     rejected outright — a relative quantity is arithmetic, and the model
//     never does arithmetic.
//  4. Date-component explosion (2026-06-03 -> 2026, 6, 3) let the model
//     recombine components into wrong dates ("July 3"). Dates are validated
//     STRUCTURALLY: date phrases are extracted, matched against payload
//     dates as (y, m, d) tuples, and consumed before the numeric pass; ISO
//     strings no longer leak their components as free integers.
//  5. Magnitude-only matching let payload numbers be re-issued in any unit
//     ("45%" from lagDays 45). Percent/bps claims now check a percent-keyed
//     allowed set built from field NAMES, not just values.
//  6. entityCheck's prefix skip (^Senate...) exempted fabricated
//     institutions ("Senate Ethics Committee"); substring containment let
//     $ROE pass via "Jane Roe". Furniture is now an exact-string set derived
//     from ARCHETYPES attributions; tickers/CAPS match case-SENSITIVELY with
//     token boundaries; hyphenated surnames match as compound names.
//
// The never-list check is checkRegister, REUSED not rewritten (recalibrated
// 2026-07-27: match CONSTRUCTIONS, never bare words). Every pattern bank
// here follows that law and ships with its false-positive corpus as tests.

export interface ValidationIssue {
  readonly rule: string;
  readonly detail: string;
}

export type Variant = "dry" | "sharp" | "commentary";

// ---------------------------------------------------------------------------
// GROUP 1 — the no-fabrication floor
// ---------------------------------------------------------------------------

const SCALE_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(billion|bn|B)$/i, 1e9],
  [/^(million|mm|M)$/i, 1e6],
  [/^(thousand|K)$/i, 1e3],
];

function canon(n: number): string {
  return Number(n.toPrecision(12)).toString();
}

const ISO_DATETIME_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?/g;

export interface PayloadFacts {
  /** Canonical numeric values the payload actually states. */
  readonly numbers: Set<string>;
  /** Values under percent-ish field names — the only numbers claimable as % or bps. */
  readonly percents: Set<string>;
  /** Dates the payload states, as "m-d" and "y-m-d" keys. */
  readonly dates: Set<string>;
  readonly json: string;
}

const PERCENT_KEY_RE = /(pct|percent|rate|yield|yoy|mom|qoq|bps|ratio|share|coverage|cover|change|chg|alloc)/i;

export function payloadFacts(payload: Payload): PayloadFacts {
  const numbers = new Set<string>();
  const percents = new Set<string>();
  const dates = new Set<string>();

  const addNumber = (n: number, percentContext: boolean): void => {
    if (!Number.isFinite(n)) return;
    numbers.add(canon(n));
    numbers.add(canon(Math.abs(n)));
    // Guarded scale-DOWN only: a large payload number licenses its short form
    // ("1.2" for 1200000). NOTHING licenses upward — that was CRITICAL #1.
    if (Math.abs(n) >= 1000) for (const [, f] of SCALE_WORDS) numbers.add(canon(n / f));
    if (percentContext) {
      percents.add(canon(n));
      percents.add(canon(Math.abs(n)));
    }
  };

  const walkString = (v: string, percentContext: boolean): void => {
    // Structural dates first, then strip them so their components never
    // enter the numeric set as free integers (bypass #4).
    for (const m of v.matchAll(ISO_DATETIME_RE)) {
      const [y, mo, d] = m[0].slice(0, 10).split("-").map(Number);
      dates.add(`${mo}-${d}`);
      dates.add(`${y}-${mo}-${d}`);
      addNumber(y!, false); // the year alone is a legitimate standalone claim
    }
    const stripped = v.replace(ISO_DATETIME_RE, " ");
    for (const m of stripped.matchAll(/\d[\d,]*\.?\d*/g)) {
      addNumber(Number(m[0].replace(/,/g, "")), percentContext);
    }
    // "2.4%" inside a payload string is a percent claim wherever it lives.
    for (const m of stripped.matchAll(/(\d[\d,]*\.?\d*)\s*%/g)) {
      percents.add(canon(Number(m[1]!.replace(/,/g, ""))));
    }
  };

  const walk = (v: unknown, keyPath: string): void => {
    const percentContext = PERCENT_KEY_RE.test(keyPath);
    if (typeof v === "number") addNumber(v, percentContext);
    else if (typeof v === "string") walkString(v, percentContext);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, keyPath));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(payload, "");
  return { numbers, percents, dates, json: JSON.stringify(payload) };
}

/**
 * Facts from GROUNDING TEXT (source document + lake context) — the p4-01
 * widening. Same primitives and the same bypass guards as payloadFacts:
 * dates parse structurally (phrase and ISO), numbers enter at their PARSED
 * value (a "45,000" in the source never licenses "$45 billion" — the draft
 * side's scale multiplication runs against the parsed set), percents only
 * from tokens the source itself marks as % / bps, spelled-out numbers at
 * their word value. The raw text becomes part of the entity/verbatim
 * haystack via mergeFacts.
 */
export function groundingFacts(grounding: string): PayloadFacts {
  const numbers = new Set<string>();
  const percents = new Set<string>();
  const dates = new Set<string>();

  const addNumber = (n: number): void => {
    if (!Number.isFinite(n)) return;
    numbers.add(canon(n));
    numbers.add(canon(Math.abs(n)));
    // Same scale-DOWN-only licensing as payloadFacts; nothing scales up.
    if (Math.abs(n) >= 1000) for (const [, f] of SCALE_WORDS) numbers.add(canon(n / f));
  };

  // Dates first, consumed — their components must not leak into the numeric
  // set as free integers. The grounding grammar is DELIBERATELY narrower than
  // the draft-side DATE_PHRASE_RE: month-name and ISO forms only. Free prose
  // is full of slash tokens that are not dates ("a 3/4 majority", "24/7"),
  // and each would otherwise license a fabricated month-day (review finding).
  const afterDates = grounding.replace(GROUNDING_DATE_RE, (_, mn1, d1, y1, d2, mn2, y2, yIso, mIso, dIso) => {
    let m: number | undefined, d: number | undefined, y: number | undefined;
    if (mn1) [m, d, y] = [MONTHS[String(mn1).toLowerCase()], Number(d1), y1 ? Number(y1) : undefined];
    else if (mn2) [m, d, y] = [MONTHS[String(mn2).toLowerCase()], Number(d2), y2 ? Number(y2) : undefined];
    else [y, m, d] = [Number(yIso), Number(mIso), Number(dIso)];
    dates.add(`${m}-${d}`);
    if (y !== undefined) {
      dates.add(`${y}-${m}-${d}`);
      addNumber(y);
    }
    return " ";
  });

  // Clock times consumed next, mirroring numberCheck's own time pass: "9:30
  // a.m." must not hand 9 and 30 to the licensed set (review finding — the
  // draft side closed this as bypass #4; the grounding side must match).
  const afterTimes = afterDates.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");

  // Numeric tokens with a grounding-specific suffix grammar: WORD scales
  // only, case-insensitive ("$2.3 Billion" in a headline licenses 2.3e9),
  // and NO single-letter [MKB] suffixes — "Exhibit 8 B" in a legal document
  // must never license 8,000,000,000 (review finding).
  for (const m of afterTimes.matchAll(/\$?(\d[\d,]*\.?\d*)\s*(%|bps\b|billion\b|bn\b|million\b|mm\b|thousand\b)?/gi)) {
    const base = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const suffix = m[2]?.toLowerCase();
    if (suffix === "%" || suffix === "bps") {
      addNumber(base);
      percents.add(canon(base));
      percents.add(canon(Math.abs(base)));
      continue;
    }
    const scale = suffix ? SCALE_WORDS.find(([re]) => re.test(suffix))?.[1] : undefined;
    addNumber(scale !== undefined ? base * scale : base);
  }
  // Spelled-out numbers in the source license spelled-out claims.
  const words = afterTimes.toLowerCase().split(/[^a-z0-9-]+/);
  for (let i = 0; i < words.length; i++) {
    const base = WORD_UNITS[words[i]!];
    if (base === undefined) continue;
    const scale = WORD_SCALES[words[i + 1] ?? ""];
    addNumber(scale !== undefined ? base * scale : base);
  }

  return { numbers, percents, dates, json: grounding };
}

/** Union of two fact universes; the haystacks concatenate so entity and
 *  verbatim checks see both. */
/**
 * Does this grounding text actually belong to this item?
 *
 * THE THREAT (found 2026-08-01 by the ingestion session, on EDGAR). p4-01's
 * fallback fetched `source_url`, which for edgar_8k is the INDEX page — 2,077
 * characters of navigation chrome and a Google Tag Manager snippet. Every
 * check downstream looked healthy: the fetch succeeded, the text was
 * non-empty, the model wrote around it.
 *
 * The danger is not thin prose. `mergeFacts` widens the validator whitelist to
 * payload ∪ source ∪ context, so a WRONG source document licenses ITS numbers
 * and entities in our posts. Chrome carries script ids and timestamps; another
 * company's filing carries another company's figures. A mis-fetch is a
 * fabrication license, and the no-fabrication floor is precisely the thing
 * that must not widen on unverified input.
 *
 * So the widening fails CLOSED: grounding facts merge only when the text
 * carries at least one anchor the payload also carries (company, ticker, CIK,
 * issuer, member, symbol — matched token-bounded, case-insensitively). The
 * text still reaches the PROMPT either way; only its licensing authority is
 * withheld, so a bad fetch degrades to "the model saw something unhelpful"
 * rather than "the model may now state anything that document contained".
 *
 * Absent grounding is not a failure: no text means nothing to verify and
 * nothing to widen. Absence and wrongness are different, and this returns
 * `ok` for the first and `false` for the second.
 */
/**
 * Is this text PROSE, or is it a document's internals?
 *
 * The anchor check alone is not enough, and I verified that rather than
 * assuming it. SEC litigation PDFs carry `/Title (In the Matter of ACME
 * CAPITAL ADVISERS LLC)` in their metadata, so a naive tag-strip of the PDF
 * yields 106,641 characters of object tables **that contain the respondent's
 * name**. The anchor matches, provenance passes, and `/Prev 223302`,
 * `/Size 312`, `/Length 41728` enter the fact whitelist as licensed numbers.
 *
 * The two checks catch different failures and neither subsumes the other:
 *   anchor  — a wrong document that IS prose (EDGAR nav chrome, another
 *             company's filing)
 *   prose   — the right document that ISN'T prose (a PDF whose metadata
 *             happens to name the payload's company)
 *
 * Measured word ratios (tokens that are plain words / all tokens):
 *   PDF object tables      0.29
 *   EDGAR index chrome     0.87
 *   real 8-K filing body   0.92
 *   real press release     1.00
 *   owner exemplar         0.81   <- lowest legitimate: numbers and symbols
 * 0.6 sits with roughly 2x margin either side.
 *
 * Short text is exempt: a ratio over a handful of tokens is noise, and lake
 * context lines are legitimately terse.
 */
export const PROSE_MIN_TOKENS = 20;
export const PROSE_MIN_WORD_RATIO = 0.6;

/**
 * Binary masquerading as text, checked INDEPENDENTLY of length.
 *
 * Found 2026-08-01 by testing my own gate against the XLSX class the
 * ingestion session had just discovered (ten BoJ "HTML" items were
 * spreadsheets). A tag-stripped .xlsx yields ~10 whitespace-separated tokens,
 * because binary has almost no spaces — so it fell UNDER the 20-token
 * exemption I added to protect terse lake-context lines, `looksLikeProse`
 * returned true, and the `docProps` title ("Bank of Japan Monetary Base")
 * then satisfied the anchor check. The zip container's numbers would have
 * been licensed.
 *
 * The exemption was the hole: short text is only trustworthy if it is TEXT.
 * Control bytes and U+FFFD are conclusive regardless of length, so this runs
 * first and has no minimum.
 */
function looksBinaryText(text: string): boolean {
  if (text === "") return false;
  // Any C0 control byte other than tab/newline/carriage-return.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return true;
  // Replacement characters mean a decode already failed.
  const repl = (text.match(/\uFFFD/g) ?? []).length;
  return repl / text.length > 0.01;
}

export function looksLikeProse(text: string): boolean {
  // Binary first, and length-independent: a short binary blob is still binary.
  if (looksBinaryText(text)) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < PROSE_MIN_TOKENS) return true;
  const words = tokens.filter((t) => /^[A-Za-z][A-Za-z'\u2019-]*[.,;:)!?]?$/.test(t));
  return words.length / tokens.length >= PROSE_MIN_WORD_RATIO;
}

/**
 * Anchor classes, in strength order. The first version treated every field as
 * equally probative and fell back to a single shared token, which a review
 * showed licenses another company's document outright.
 *
 * CODES are unique by construction. SYMBOLS are NOT — see SYMBOL_FIELDS; a
 * ticker is a word, and it anchors only where a filing prints it as a symbol.
 * NAMES are matched WHOLE (after normalisation), never by token: "Acme
 * Pharmaceuticals, Inc." and "Sorrento Pharmaceuticals, Inc." share
 * "Pharmaceuticals", and so do Holdings, Technologies, Capital and Partners.
 * SITE_WIDE values ('SEC', 'CFTC') appear in the footer of every page on the
 * regulator's own site, so they can never license anything alone.
 */
const CODE_FIELDS = [
  "cik", "issuerCik", "accession", "accessionNumber",
  "recallNumber", "eventId", "docketNumber", "fileNumber",
] as const;

/**
 * Exchange symbols, held apart from CODE_FIELDS because they are not codes.
 *
 * Measured against the live issuers table: of 5,906 four- and five-character
 * tickers, 371 are ordinary English words. Measured against 14 real 8-K
 * filings pulled from the EDGAR daily index for 2026-07-30/31, EVERY filing
 * contains at least 11 of those as bare prose words, median 23; FORM, LINE,
 * SUCH, WHEN, WELL and ELSE appear in nearly all of them, and FORM appears in
 * every SEC filing ever written. So the previous ">= 4 chars or a digit" rule
 * did not leak occasionally — it licensed every document it was ever shown.
 *
 * Length is not a proxy for distinctiveness at ANY length: LOVE is four
 * characters and less distinctive than the three-character BLNK. The rule is
 * therefore about SHAPE, not size: a symbol anchors only where the text prints
 * it the way filings print symbols. See symbolAppearsAsSymbol.
 */
const SYMBOL_FIELDS = ["ticker", "symbol"] as const;

const NAME_FIELDS = [
  "company", "companyName", "issuer", "issuerName", "member", "filer",
  "filerName", "name", "firm", "product", "respondent", "counterparty",
  // Added after an audit found these live payload shapes had NO anchor at all:
  "display", "who", "lastName",   // senatePtr
  "title",                        // regulatoryPress / fedPress — a release page
                                  // carries its own headline, so this converts
                                  // those sources from fail-open to verified.
] as const;

/** Never sufficient alone: these are site-wide tokens, not record identity. */
const SITE_WIDE_FIELDS = ["authority", "exchange", "regulator"] as const;

/**
 * A code must carry a digit. That is the discriminating property, and it is by
 * construction rather than by threshold: nothing that reads as an English word
 * survives it. Checked against 1,500 live payloads — every cik, issuerCik and
 * accession present carries digits (0 exceptions) and the shortest is seven
 * characters, so this excludes nothing real. The `>= 4` is not a
 * distinctiveness proxy; it only keeps a hypothetical bare three-digit code
 * out, since "123" in a document is a quantity, not an identity.
 */
function isUsableCode(v: string): boolean {
  return /\d/.test(v) && v.length >= 4;
}

/** Exchanges and labels that introduce a symbol in filings and releases. */
const SYMBOL_MARKER =
  /(?:nyse(?:\s+(?:american|arca))?|nasdaq|amex|cboe|otcqb|otcqx|otc(?:\s+markets)?|tsxv?|lse|bats|iex|ticker|trading\s+symbol|symbol|listed\s+(?:as|under)|trades?\s+(?:as|under)|under\s+the\s+symbol)\b[^A-Za-z0-9]{0,12}$/i;
/** Cover-page tables put the "Trading Symbol(s)" heading a column away. */
const SYMBOL_HEADING = /trading\s+symbol\(?s?\)?[\s\S]{0,120}$/i;
const OPEN_DELIM = /[("'“‘]\s*$/;
const CLOSE_DELIM = /^\s*[)"'”’]/;

/**
 * Does the text print this ticker AS A TICKER, rather than merely contain the
 * word? Filings write symbols in exactly a few ways: parenthesised or quoted
 * ("(LOVE)", "\"LOVE\""), introduced by an exchange or label ("Nasdaq: LOVE",
 * "under the symbol LOVE"), or under a cover-page "Trading Symbol(s)" heading.
 * A bare occurrence counts for nothing, which is what kills the 371 word-shaped
 * tickers: "well", "form" and "such" are never printed as symbols.
 *
 * Case is load-bearing and deliberately not normalised away — symbols are
 * uppercase in filings, the colliding prose words are not. Grounding text that
 * arrives already lowercased therefore never matches here and falls through to
 * the name anchor. That direction is fail-CLOSED (licensing withheld), which
 * is the direction this gate is allowed to be wrong in.
 */
function symbolAppearsAsSymbol(grounding: string, symbol: string): boolean {
  const sym = symbol.trim().toUpperCase();
  if (sym === "" || !/^[A-Z][A-Z0-9.-]*$/.test(sym)) return false;
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(sym)}(?![A-Za-z0-9])`, "g");
  for (let m = re.exec(grounding); m !== null; m = re.exec(grounding)) {
    const before = grounding.slice(Math.max(0, m.index - 160), m.index);
    const after = grounding.slice(m.index + sym.length, m.index + sym.length + 4);
    if (OPEN_DELIM.test(before) && CLOSE_DELIM.test(after)) return true;
    if (SYMBOL_MARKER.test(before)) return true;
    if (SYMBOL_HEADING.test(before)) return true;
  }
  return false;
}

// Spaced forms exist because punctuation is replaced by spaces before this
// runs: "L.P." -> "l p", "S.A." -> "s a", "L.L.C." -> "l l c".
const LEGAL_SUFFIX =
  /\b(inc|incorporated|llc|l l c|corp|corporation|co|ltd|limited|plc|lp|l p|llp|sa|s a|nv|n v|ag|a g|holdings|holding|group|trust|se|company)\b/g;
// EDGAR conformed names carry a state suffix: "BANK OF AMERICA CORP /DE/".
const EDGAR_STATE_SUFFIX = /\/[a-z]{2}\//g;

/** Long forms mapped to short so the payload's "NVIDIA CORP" still matches a
 *  body printing "NVIDIA Corporation". Applied to BOTH sides. */
const SUFFIX_CANON: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bincorporated\b/g, "inc"],
  [/\bcorporation\b/g, "corp"],
  [/\bcompany\b/g, "co"],
  [/\blimited\b/g, "ltd"],
  [/\bl l c\b/g, "llc"],
  [/\bl p\b/g, "lp"],
  [/\bs a\b/g, "sa"],
  [/\bn v\b/g, "nv"],
  [/\ba g\b/g, "ag"],
  [/\bholdings\b/g, "holding"],
];

function basePunct(v: string): string {
  return v.toLowerCase().replace(EDGAR_STATE_SUFFIX, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Suffixes KEPT but canonicalised — the fallback form. */
function canonicalName(v: string): string {
  let out = basePunct(v);
  for (const [re, to] of SUFFIX_CANON) out = out.replace(re, to);
  return out.replace(/\s+/g, " ").trim();
}

/** Suffixes REMOVED — the preferred form when it stays distinctive. */
function strippedName(v: string): string {
  return canonicalName(v).replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

/**
 * WHICH FORM OF A NAME MAY ANCHOR, decided by construction rather than by a
 * length threshold.
 *
 * A single token is never distinctive enough to prove provenance, at ANY
 * length. This is not a theoretical worry: of the 8,043 issuers in our own
 * reference table, **2,081 (26%) have a conformed name that reduces to one
 * token**, and ten of those reduce to a common English word — Block, Box,
 * Crown, Freedom, Frontier, Gap, Noble, On (On Holding AG), Target (twice).
 * "on" and "now" appear in essentially every document ever written.
 *
 * The first hardening tried a length floor (>= 6 chars). That was a patch on
 * the symptom and it still admitted "market", "target", "square". The rule
 * here has no threshold to tune: **use the stripped form only if it is
 * multi-token; else the canonical form only if IT is multi-token; else the
 * name cannot anchor anything and is dropped.**
 *
 * Dropping is safe and honest — the caller falls through to identifiers and,
 * failing those, returns `no_usable_anchor`, a VISIBLE fail-open. A name we
 * cannot verify with is not a verification.
 */
function anchorForm(name: string): string | null {
  const stripped = strippedName(name);
  if (stripped.includes(" ")) return stripped;
  const canon = canonicalName(name);
  if (canon.includes(" ")) return canon;
  return null; // e.g. "RH" — nothing here can discriminate
}

export interface GroundingProvenance {
  readonly ok: boolean;
  readonly matched: string | null;
  readonly anchorsTried: number;
  /** "not_prose" | "no_anchor" | "no_usable_anchor" when it fails. */
  readonly reason: string | null;
}

function collect(payload: Payload, fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const v = (payload as Record<string, unknown>)[f];
    if (typeof v === "string" && v.trim().length >= 3) out.push(v.trim());
    else if (typeof v === "number" && String(v).length >= 3) out.push(String(v));
  }
  return out;
}

/**
 * Does this grounding text actually belong to this item?
 *
 * `mergeFacts` widens the validator whitelist to payload ∪ source ∪ context,
 * so a WRONG source document licenses ITS numbers in our posts. Failure
 * withholds LICENSING, not visibility — the text still reaches the prompt.
 *
 * ABSENCE IS NOT WRONGNESS: empty grounding, or a payload with no usable
 * anchor, returns ok — but the latter returns reason `no_usable_anchor` and is
 * logged, because a silent fail-open is the shape this whole exercise is about.
 */
export function checkGroundingProvenance(grounding: string, payload: Payload): GroundingProvenance {
  if (grounding.trim() === "") return { ok: true, matched: null, anchorsTried: 0, reason: null };
  if (!looksLikeProse(grounding)) return { ok: false, matched: null, anchorsTried: 0, reason: "not_prose" };

  const hay = grounding.toLowerCase();
  const codes = collect(payload, CODE_FIELDS).filter(isUsableCode);
  const symbols = collect(payload, SYMBOL_FIELDS);
  const names = collect(payload, NAME_FIELDS);
  const tried = codes.length + symbols.length + names.length;

  for (const code of codes) {
    if (new RegExp(`(?<![a-z0-9])${escapeRegExp(code.toLowerCase())}(?![a-z0-9])`).test(hay)) {
      return { ok: true, matched: code, anchorsTried: tried, reason: null };
    }
  }

  // Symbols are checked against the ORIGINAL text, not `hay`: case carries the
  // signal, and lowercasing first would throw it away before the test.
  for (const sym of symbols) {
    if (symbolAppearsAsSymbol(grounding, sym)) {
      return { ok: true, matched: sym, anchorsTried: tried, reason: null };
    }
  }

  const hayStripped = strippedName(grounding);
  const hayCanon = canonicalName(grounding);
  let usableNames = 0;
  for (const n of names) {
    const needle = anchorForm(n);
    if (needle === null || needle.length < 3) continue; // cannot discriminate
    usableNames += 1;
    const target = needle === strippedName(n) ? hayStripped : hayCanon;
    if (new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`).test(target)) {
      return { ok: true, matched: n, anchorsTried: tried, reason: null };
    }
  }

  // Nothing usable to test with — no code carried a digit, no symbol was
  // present, and every name reduced to a single token. Fail open, but VISIBLY.
  //
  // A symbol that WAS present and did not appear in symbol shape counts as a
  // real test that failed, not as absence of evidence, so it lands on
  // `no_anchor` below and withholds licensing.
  if (codes.length === 0 && symbols.length === 0 && usableNames === 0) {
    return { ok: true, matched: null, anchorsTried: tried, reason: "no_usable_anchor" };
  }
  return { ok: false, matched: null, anchorsTried: tried, reason: "no_anchor" };
}

/** Consumed by the ANCHOR COVERAGE AUDIT in test/ragValidate.test.ts, which
 *  asserts every live archetype payload shape offers at least one anchor —
 *  the test this comment previously only promised. */
export const ALL_ANCHOR_FIELDS: readonly string[] = [
  ...CODE_FIELDS, ...SYMBOL_FIELDS, ...NAME_FIELDS,
];
export const NON_ANCHOR_FIELDS: readonly string[] = [...SITE_WIDE_FIELDS];

export function mergeFacts(a: PayloadFacts, b: PayloadFacts): PayloadFacts {
  return {
    numbers: new Set([...a.numbers, ...b.numbers]),
    percents: new Set([...a.percents, ...b.percents]),
    dates: new Set([...a.dates, ...b.dates]),
    json: `${a.json}\n${b.json}`,
  };
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAME = Object.keys(MONTHS).join("|");
// "June 3", "June 3, 2026", "3 June", ISO, M/D and M/D/YYYY.
const DATE_PHRASE_RE = new RegExp(
  `\\b(?:(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?` +
    `|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?(?:,?\\s+(\\d{4}))?` +
    `|(\\d{4})-(\\d{2})-(\\d{2})` +
    `|(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?)\\b`,
  "gi",
);

/** Grounding-side date grammar: month-name and ISO forms ONLY. The slash
 *  form stays draft-side (DATE_PHRASE_RE) where it validates a claim; over
 *  free source prose it would mint dates from fractions and dockets. */
const GROUNDING_DATE_RE = new RegExp(
  `\\b(?:(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?` +
    `|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?(?:,?\\s+(\\d{4}))?` +
    `|(\\d{4})-(\\d{2})-(\\d{2}))\\b`,
  "gi",
);

/** Validate every date phrase in the draft against the payload's dates, and
 *  return the text with those phrases consumed (bypass #4). */
export function dateCheck(text: string, facts: PayloadFacts): { issues: ValidationIssue[]; remainder: string } {
  const issues: ValidationIssue[] = [];
  const remainder = text.replace(
    DATE_PHRASE_RE,
    (raw, mn1, d1, y1, d2, mn2, y2, yIso, mIso, dIso, mSlash, dSlash, ySlash) => {
      let m: number | undefined, d: number | undefined, y: number | undefined;
      if (mn1) [m, d, y] = [MONTHS[String(mn1).toLowerCase()], Number(d1), y1 ? Number(y1) : undefined];
      else if (mn2) [m, d, y] = [MONTHS[String(mn2).toLowerCase()], Number(d2), y2 ? Number(y2) : undefined];
      else if (yIso) [y, m, d] = [Number(yIso), Number(mIso), Number(dIso)];
      else {
        const yy = ySlash ? Number(ySlash) : undefined;
        [m, d, y] = [Number(mSlash), Number(dSlash), yy !== undefined && yy < 100 ? yy + 2000 : yy];
      }
      const ok = y !== undefined ? facts.dates.has(`${y}-${m}-${d}`) : facts.dates.has(`${m}-${d}`);
      if (!ok) issues.push({ rule: "number", detail: `date "${String(raw)}" does not match any payload date` });
      return " ";
    },
  );
  return { issues, remainder };
}

// --- spelled-out numbers (bypass #3) ---------------------------------------

const WORD_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12,
};
const WORD_SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const RELATIVE_WORDS =
  /\b(doubl(?:e|ed|ing)|tripl(?:e|ed|ing)|halv(?:e|ed|ing)|half\s+(?:of\s+)?(?:the|that|its)|a\s+(?:third|quarter|fifth)\s+of|twice)\b/i;
const QUANTITY_NOUN = /^(share|filing|trade|contract|day|week|month|year|percent|point|bp|bps|dollar|post|buyer|seller|member|halt)s?$/i;

export function wordNumberCheck(text: string, facts: PayloadFacts): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rel = RELATIVE_WORDS.exec(text);
  if (rel) {
    issues.push({ rule: "number", detail: `relative quantity "${rel[0]}" — payload numbers only, never derived ones` });
  }
  const words = text.toLowerCase().split(/[^a-z0-9-]+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const compound = w.includes("-") ? w.split("-") : null;
    let value: number | undefined;
    let consumed = 1;
    if (compound && compound.length === 2 && WORD_UNITS[compound[0]!] !== undefined && WORD_UNITS[compound[1]!] !== undefined) {
      value = WORD_UNITS[compound[0]!]! + WORD_UNITS[compound[1]!]!; // forty-six
    } else if (WORD_UNITS[w] !== undefined) {
      value = WORD_UNITS[w]!;
    } else {
      continue;
    }
    const next = words[i + 1];
    if (next && WORD_SCALES[next] !== undefined) {
      value *= WORD_SCALES[next]!; // "nine million"
      consumed = 2;
    } else if (value <= 9) {
      // Small units are everyday English ("no one filed"). They only count
      // as numeric claims when they quantify something.
      if (!QUANTITY_NOUN.test(next ?? "")) continue;
    }
    if (!facts.numbers.has(canon(value))) {
      issues.push({
        rule: "number",
        detail: `spelled-out "${words.slice(i, i + consumed).join(" ")}" (${value}) does not appear in the payload`,
      });
    }
    i += consumed - 1;
  }
  return issues;
}

// --- digit tokens ----------------------------------------------------------

export function draftNumbers(text: string): Array<{ raw: string; value: number; unit: "percent" | "plain" }> {
  const out: Array<{ raw: string; value: number; unit: "percent" | "plain" }> = [];
  for (const m of text.matchAll(/\$?(\d[\d,]*\.?\d*)\s*(%|bps|billion|bn|million|mm|thousand|[MKB]\b)?/g)) {
    const base = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    let value = base;
    let unit: "percent" | "plain" = "plain";
    const suffix = m[2];
    if (suffix) {
      if (/^(%|bps)$/i.test(suffix)) unit = "percent";
      else for (const [re, f] of SCALE_WORDS) if (re.test(suffix)) value = base * f;
    }
    out.push({ raw: m[0].trim(), value, unit });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function numberCheck(text: string, payload: Payload, precomputed?: PayloadFacts): ValidationIssue[] {
  const facts = precomputed ?? payloadFacts(payload);
  // Dates first, structurally, consuming their tokens.
  const { issues, remainder: afterDates } = dateCheck(text, facts);
  // Times next ("19:50"): ISO timestamps no longer leak 19 and 50 as free
  // integers, so a time claim must match a payload timestamp verbatim,
  // digit-bounded, and is then consumed whole.
  const remainder = afterDates.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (t) => {
    if (!new RegExp(`(?<![0-9])${escapeRegExp(t)}(?![0-9])`).test(facts.json)) {
      issues.push({ rule: "number", detail: `time "${t}" does not appear in the payload` });
    }
    return " ";
  });
  for (const { raw, value, unit } of draftNumbers(remainder)) {
    if (unit === "percent") {
      // A % or bps claim must come from a percent-context payload field
      // (bypass #5: lagDays 45 must never become "45%").
      if (facts.percents.has(canon(value))) continue;
      issues.push({ rule: "number", detail: `"${raw}" is not a percent the payload states` });
      continue;
    }
    if (facts.numbers.has(canon(value))) continue;
    // Verbatim fallback, TIGHTENED (bypass #2): only tokens carrying a
    // non-digit character (times like 19:50, codes like 8-K), matched with
    // digit boundaries so "100000" can never ride inside "1000001".
    const bare = raw.replace(/[$,]/g, "");
    if (/[^0-9.]/.test(bare) && new RegExp(`(?<![0-9])${escapeRegExp(bare)}(?![0-9])`).test(facts.json)) continue;
    issues.push({ rule: "number", detail: `"${raw}" does not appear in the payload` });
  }
  issues.push(...wordNumberCheck(remainder, facts));
  return issues;
}

// --- entities --------------------------------------------------------------

/** Wire furniture that is never an entity claim: the attribution strings
 *  themselves (derived from the archetype table, never a drifting hand list)
 *  plus regulator/format vocabulary. */
function furnitureSet(): Set<string> {
  const out = new Set<string>([
    "SEC", "EDGAR", "BLS", "FDA", "CFTC", "FTC", "FCA", "ECB", "FOMC", "DOJ",
    "NYSE", "OTC", "IPO", "ET", "UTC", "CIK", "CEO", "CFO", "COO", "CTO", "GDP", "CPI", "PPI", "PCE",
    "LUDP", "LUDS", "USD", "EUR", "GBP", "PTR", "EFD",
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST",
    "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
    "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY",
  ]);
  for (const a of Object.values(ARCHETYPES)) {
    const attr: unknown = a.attribution;
    const strings = typeof attr === "string" ? [attr] : Object.values((attr as { map?: Record<string, string> }).map ?? {});
    for (const s of strings) {
      const phrase = s.replace(/^per\s+/i, "");
      out.add(phrase.toUpperCase());
      for (const w of phrase.split(/\s+/)) out.add(w.toUpperCase());
    }
  }
  return out;
}

const FURNITURE = furnitureSet();

/** Token-bounded existence check against the payload JSON — substring
 *  containment let $ROE pass via "Jane Roe" (bypass #16). Tickers and CAPS
 *  match case-SENSITIVELY: "Roe" in the payload never licenses "ROE". */
function inPayload(json: string, token: string, caseSensitive: boolean): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, caseSensitive ? "" : "i");
  return re.test(json);
}

export function entityCheck(text: string, payload: Payload, precomputed?: PayloadFacts): ValidationIssue[] {
  const json = (precomputed ?? payloadFacts(payload)).json;
  const issues: ValidationIssue[] = [];
  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) {
    if (!inPayload(json, m[1]!, true)) {
      issues.push({ rule: "entity", detail: `ticker "$${m[1]}" does not appear in the payload` });
    }
  }
  const withoutTickers = text.replace(/\$[A-Z]{1,5}\b/g, "");
  for (const m of withoutTickers.matchAll(/\b([A-Z]{2,})\b/g)) {
    if (FURNITURE.has(m[1]!)) continue;
    if (!inPayload(json, m[1]!, true)) {
      issues.push({ rule: "entity", detail: `all-caps token "${m[1]}" does not appear in the payload` });
    }
  }
  // Multi-word proper nouns INCLUDING hyphenated compounds ("Ocasio-Cortez");
  // space-only matching split those into unchecked single words (bypass #19).
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[-\s][A-Z][a-z]+)+)\b/g)) {
    const name = m[1]!;
    // Exact furniture phrases only — a PREFIX skip exempted "Senate Ethics
    // Committee" wholesale (bypass #6).
    if (FURNITURE.has(name.toUpperCase())) continue;
    if (!inPayload(json, name, false)) {
      issues.push({ rule: "entity", detail: `name "${name}" does not appear in the payload` });
    }
  }
  return issues;
}

// --- sourcing, urls, structure, length -------------------------------------

/** Non-negotiable #2 enforced mechanically (finding #18): secondary-sourcing
 *  constructions, and any "per X" whose X is not one of OUR records. */
const SOURCING_PATTERNS: readonly RegExp[] = [
  /\breportedly\b/i,
  /\bsources?\s+(say|said|tell|told|familiar)\b/i,
  /\baccording to (reports|people|sources|a report)\b/i,
  /\bciting\b/i,
  /\bmedia reports?\b/i,
];

function allowedAttributions(): string[] {
  // The rate-phrase senses of "per" are English, not attribution; without
  // them "250 posts per day" reads as citing an outlet named Day.
  const out: string[] = [
    "per Skeptic's tape",
    "per day", "per week", "per month", "per year", "per annum",
    "per share", "per contract", "per ounce", "per barrel", "per rolling",
  ];
  for (const a of Object.values(ARCHETYPES)) {
    const attr: unknown = a.attribution;
    if (typeof attr === "string") out.push(attr);
    else out.push(...Object.values((attr as { map?: Record<string, string> }).map ?? {}));
  }
  return out;
}

const ALLOWED_ATTRIBUTIONS = allowedAttributions();

export function sourcingCheck(text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hit = SOURCING_PATTERNS.find((re) => re.test(text));
  if (hit) issues.push({ rule: "sourcing", detail: `secondary sourcing: ${String(hit.exec(text)?.[0])}` });
  // Every "per ..." must be one of our attributions — "per Bloomberg" is
  // republishing wearing our furniture.
  for (const m of text.matchAll(/\bper\s+\S[^.,\n]*/gi)) {
    if (!ALLOWED_ATTRIBUTIONS.some((a) => m[0].toLowerCase().startsWith(a.toLowerCase()))) {
      issues.push({ rule: "sourcing", detail: `attribution "${m[0].slice(0, 40)}" is not one of our records` });
    }
  }
  return issues;
}

/** The model receives no URL and must emit none; the source link rides in a
 *  reply (p2r-05). Belt to that brace (finding #10). */
export function urlCheck(text: string): ValidationIssue[] {
  // Scheme-less official domains too ("SEC.gov" in agency boilerplate): X
  // links them like any URL, so they'd bill 23 weighted while our counter
  // sees 7 — and the post contract is no links at all (review finding).
  return /(?:https?:\/\/|\bwww\.|\bt\.co\b|\b[a-z0-9][a-z0-9.-]*\.(?:gov|mil|int)\b|\b[a-z0-9][a-z0-9.-]*\.(?:europa\.eu|org\.uk|or\.jp|gov\.au|gov\.br|co\.za)\b)/i.test(
    text,
  )
    ? [{ rule: "url", detail: "URLs never ride in the post body; the source goes in the reply" }]
    : [];
}

export function structuralCheck(text: string, variant: Variant = "dry"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const segments = text.split(/\n\n+/);
  // The commentary shape is the OWNER'S, demonstrated in his exemplars:
  // fact block / short punch / take — three segments. Wire stays fact+beat.
  const maxSegments = variant === "commentary" ? 3 : 2;
  if (segments.length > maxSegments) {
    issues.push({ rule: "structure", detail: `${segments.length} segments; limit ${maxSegments} for ${variant}` });
  }
  if (!/\bper .+/.test(segments[0] ?? "")) {
    issues.push({ rule: "structure", detail: "attribution must ride the fact block, not the take" });
  }
  return issues;
}

/**
 * The shortest TAKE the owner has ever signed off, in weighted characters.
 *
 * Measured across all 27 OWNER_EXEMPLARS: takes run 75 to 271, median 124.
 * 75 is not a chosen threshold — it is the observed floor of the voice this
 * validator enforces, so anything above it would reject text he has written.
 */
export const MIN_TAKE_WEIGHTED = 75;

/**
 * What a GOOD take costs — the owner's MEDIAN, not his minimum.
 *
 * This is a target, never a boundary, and the distinction is the point.
 * Models satisfice: told a range starting at 75, output converges just past
 * 75, and the median draft lands ~40% below the median of the voice it is
 * imitating. Every one of them passes, the validator works perfectly, and the
 * posts are thinner than his — the original complaint arriving through a new
 * door.
 *
 * Raising the FLOOR to 124 is the wrong fix: it would reject 11 of his 27
 * signed exemplars, which is what this whole change exists to stop. So the
 * boundary and the target are separate quantities, stated separately, and the
 * prompt must never let the target read as the contract.
 */
export const TARGET_TAKE_WEIGHTED = 124;

/** The first segment: fact block plus attribution, per the structural law. */
function factBlockOf(text: string): string {
  return text.split(/\n+/).map((s) => s.trim()).find(Boolean) ?? "";
}

/**
 * What a commentary variant must reach, GIVEN WHAT THE RECORD SUPPORTS.
 *
 * The flat 200 was the forcing function behind unsourced world-knowledge.
 * Measured: the fact block a live item can produce runs 46-190 weighted chars
 * (median 86 for halts), so a flat 200 demanded 85-154 characters the record
 * could not fund — and the only remaining source is the model's knowledge of
 * the world. The drafts were complying with a contract we wrote.
 *
 * The floor is now the record's own fact block plus the owner's shortest
 * signed take. Two properties make that safe rather than lax:
 *
 *  - It is computed from the TEMPLATE DRAFT, not from the model's own fact
 *    block, so a model cannot lower its own bar by writing less.
 *  - 11 of the owner's 27 exemplars sit UNDER 200 weighted. The flat floor was
 *    rejecting 41% of the voice it exists to enforce.
 *
 * Against 400 live queue rows this relaxes 61% and withholds 1%.
 */
export function commentaryFloor(templateDraft: string): number {
  return weightedLength(factBlockOf(templateDraft)) + MIN_TAKE_WEIGHTED;
}

/**
 * When even the shortest signed take cannot fit beside the record's own fact
 * block, commentary CANNOT EXIST inside the platform limit. That is
 * arithmetic, not a tuned threshold, and it is the one case where the honest
 * answer is to not ask for a take at all — the item still gets dry and sharp,
 * which are the archetype's own default and carry no length minimum.
 */
export type CommentaryVerdict = "ok" | "unmeasurable" | "no_room";

/**
 * Can this record support a take, and if not, WHY — the two reasons being
 * different facts about the world that must not share a status.
 *
 * `unmeasurable` is the degraded-render case. `commentaryFloor("")` returns
 * MIN_TAKE_WEIGHTED, which is the LOOSEST answer — correct as a validator
 * default, where a caller who forgot an argument must not cause spurious
 * rejections, and wrong as a generation decision, where it would admit a
 * 75-character take against an item whose record is real and simply failed to
 * render. Generation therefore refuses rather than inheriting the permissive
 * default: not being able to measure the record is not the same as measuring
 * a thin one.
 */
export function commentaryVerdict(templateDraft: string): CommentaryVerdict {
  if (factBlockOf(templateDraft).trim() === "") return "unmeasurable";
  return commentaryFloor(templateDraft) <= POST_TEXT_LIMIT ? "ok" : "no_room";
}

export function commentaryIsPossible(templateDraft: string): boolean {
  return commentaryVerdict(templateDraft) === "ok";
}

export function lengthCheck(text: string, variant: Variant, templateDraft = ""): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const w = weightedLength(text);
  if (w > POST_TEXT_LIMIT) issues.push({ rule: "length", detail: `${w} weighted chars, limit ${POST_TEXT_LIMIT}` });
  if (variant === "commentary") {
    // Default templateDraft of "" yields a floor of MIN_TAKE_WEIGHTED, which
    // is the LOOSEST answer. A caller that forgets the draft gets a permissive
    // length rule rather than a spuriously strict one — the strictness lives
    // in the fabrication floor, and a length rule failing closed here would
    // reject legitimate short commentary for a plumbing mistake.
    const floor = commentaryFloor(templateDraft);
    if (w < floor) {
      issues.push({
        rule: "length",
        detail: `commentary is ${w} weighted chars; this record supports ${floor}-${POST_TEXT_LIMIT}`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// GROUP 1.5 — imputation (the defamation surface)
// ---------------------------------------------------------------------------

const MOTIVE_PATTERNS: readonly RegExp[] = [
  /\b\w+\s+knew\b/i,
  /\bknown all along\b/i,
  /\bknows?\s+(exactly\s+)?(what|when|something)\b/i,
  /\b(was|were|is|are)\s+aware\b/i,
  /\bhad reason to\b/i,
  /\btiming\s+(speaks|says|tells|is everything)\b/i,
  /\bspeaks for itself\b/i,
  /\bconveniently\b/i,
  /\bquietly\s+(filed|sold|bought|dumped|exited|moved)\b/i,
  /\bcoordinat(ed|ion|ing)\b/i,
  /\b(not|no)\s+a\s+coincidence\b/i,
  /\bfront[- ]?r(an|un|unning)\b/i,
];

export function motiveCheck(text: string): ValidationIssue[] {
  const hit = MOTIVE_PATTERNS.find((re) => re.test(text));
  return hit ? [{ rule: "motive", detail: `imputed knowledge/motive: ${String(hit.exec(text)?.[0])}` }] : [];
}

// ---------------------------------------------------------------------------
// GROUP 2 — the commentary contract
// ---------------------------------------------------------------------------

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

/**
 * A beat/take is a SENTENCE, not a fragment.
 *
 * Found in the first live generation (2026-08-01): the sharp variant shipped
 * `pay $35,000.` as its beat — doctrine-legal (the number is in the payload)
 * but a lowercase fragment echoing the fact block, which reads as broken
 * output rather than as a dry observation. Every beat in persona.md section 8
 * and every beat in the owner's exemplars is a complete sentence.
 *
 * Deliberately a CAPITALISATION check, not an echo check: the owner's own
 * `Nine days.` after "...filed nine days later" is a rhetorical echo and one
 * of his best beats, so rejecting restatement would reject his voice. What
 * separates his echo from the model's fragment is that his is a sentence.
 * (Openings that legitimately start non-alphabetic — a $TICKER, a number, a
 * permitted emoji — are allowed through.)
 */
/**
 * Issuers whose registered name begins lowercase. The capitalisation rule
 * would otherwise reject well-formed beats about companies we actually
 * cover — "iShares was not the buyer." is correct copy, not a fragment.
 */
const LOWERCASE_INITIAL_NAMES = /^(i[A-Z]|e[A-Z]|loanDepot|iShares|eBay|iRobot|iHeart|nCino|ePlus|dLocal|oneSpan|uniQure|bluebird|argenx|indie Semiconductor)/;

export function beatShapeCheck(text: string): ValidationIssue[] {
  // Split on ANY newline, not only blank lines. A beat one newline below the
  // fact block is the same defect — and it was the ORIGINAL one: the live
  // `pay $35,000.` case reappears verbatim when separated by \n instead of
  // \n\n, and the blank-line-only split waved it through.
  const segments = text.split(/\n+/).slice(1); // everything after the first line
  for (const seg of segments) {
    const trimmed = seg.trimStart();
    const first = trimmed.charAt(0);
    if (first === "") continue;
    if (LOWERCASE_INITIAL_NAMES.test(trimmed)) continue; // iShares, eBay, loanDepot
    if (/[a-z]/.test(first)) {
      return [{ rule: "beat_shape", detail: `beat starts lowercase ("${seg.trim().slice(0, 32)}") — a beat is a sentence, not a fragment` }];
    }
  }
  return [];
}

export function hedgeCheck(text: string): ValidationIssue[] {
  const hit = HEDGE_PATTERNS.find((re) => re.test(text));
  return hit ? [{ rule: "hedge", detail: `hedge construction: ${String(hit.exec(text)?.[0])}` }] : [];
}

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

export function templateEchoCheck(text: string, templateDraft: string): ValidationIssue[] {
  const shared = sharedNgrams(templateDraft, text);
  return shared.length > 0
    ? [{ rule: "template_echo", detail: `shares an 8-gram with the template draft: "${shared[0]}"` }]
    : [];
}

/** Probed once per RUN, not per variant — a COUNT(*) per variant was a full
 *  table scan up to 18x per run (finding #22). */
export async function corpusHasData(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS x FROM echo_ngrams LIMIT 1`).first<{ x: number }>();
  return row !== null;
}

/**
 * D1 caps NUMBERED parameters at 100 per statement:
 *   D1_ERROR: variable number must be between ?1 and ?100
 * One parameter per distinct 8-gram means text over ~108 word tokens throws
 * rather than returning issues — and a throw inside validateVariant escapes
 * runGeneration, so the failure mode is a crashed generation run, not a
 * rejected variant. Latent while echo_ngrams was empty (corpusHasData
 * short-circuits); loading 726k hashes is what armed it. Commentary at 280
 * weighted is ~45 words, but template fallbacks and owner edited_text are
 * bounded by nothing.
 */
export const D1_MAX_PARAMS = 100;
const ECHO_CHUNK = 90; // headroom under the cap

export async function corpusEchoCheck(db: D1Database, text: string): Promise<ValidationIssue[]> {
  const hashes = [...ngramHashes(text)];
  if (hashes.length === 0) return [];
  for (let i = 0; i < hashes.length; i += ECHO_CHUNK) {
    const chunk = hashes.slice(i, i + ECHO_CHUNK);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
    const hit = await db
      .prepare(`SELECT hash FROM echo_ngrams WHERE hash IN (${placeholders}) LIMIT 1`)
      .bind(...chunk)
      .first<{ hash: string }>();
    if (hit) return [{ rule: "corpus_echo", detail: "an 8-gram matches the studied corpus" }];
  }
  return [];
}

export async function collisionCheck(
  db: D1Database,
  queueId: number,
  skeletonHash: string,
  openerHash: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  // queue_id <> this row: the three variants of ONE item are alternatives
  // (only one posts); two different POSTS sharing a shape is the pattern.
  const recentSkeletons = await db
    .prepare(`SELECT skeleton_hash FROM generations WHERE status = 'valid' AND queue_id <> ?1 ORDER BY id DESC LIMIT 40`)
    .bind(queueId)
    .all<{ skeleton_hash: string }>();
  if (recentSkeletons.results.some((r) => r.skeleton_hash === skeletonHash)) {
    issues.push({ rule: "skeleton_collision", detail: "shape matches one of the last 40 valid variants" });
  }
  const recentOpeners = await db
    .prepare(`SELECT opener_hash FROM generations WHERE status = 'valid' AND queue_id <> ?1 ORDER BY id DESC LIMIT 20`)
    .bind(queueId)
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
  readonly queueId: number;
  readonly variant: Variant;
  readonly archetype: ArchetypeId;
  readonly payload: Payload;
  /** Grounding text shown to the model (source document + lake context);
   *  widens the number/entity whitelist to exactly what the prompt showed. */
  readonly grounding?: string;
  readonly templateDraft: string;
  readonly skeletonHash: string;
  readonly openerHash: string;
  /** Probed once per run via corpusHasData(); false = skip the echo query. */
  readonly corpusPopulated: boolean;
}

/**
 * The full gate. ORDER IS CONTRACT (finding #36): group-1 issues precede
 * group-2 so the recorded status names the doctrine failure over the style
 * failure when both fire — an audit row saying rejected:cadence when the
 * draft also fabricated a number would bury the finding that matters.
 */
export async function validateVariant(db: D1Database, text: string, opts: ValidateOptions): Promise<ValidationIssue[]> {
  const facts = opts.grounding
    ? mergeFacts(payloadFacts(opts.payload), groundingFacts(opts.grounding))
    : payloadFacts(opts.payload);
  const issues: ValidationIssue[] = [
    // Group 1 — the floor.
    ...numberCheck(text, opts.payload, facts),
    ...entityCheck(text, opts.payload, facts),
    ...sourcingCheck(text),
    ...urlCheck(text),
    ...motiveCheck(text),
    ...structuralCheck(text, opts.variant),
    // Payload arg (PR #53): resolves the single correct attribution for
    // chamber-mapped archetypes — the wrong-chamber check comes free.
    ...checkRegister(text, opts.archetype, opts.payload),
    ...lengthCheck(text, opts.variant, opts.templateDraft),
    // Group 2 — the contract.
    ...beatShapeCheck(text),
    ...hedgeCheck(text),
    ...cadenceCheck(text),
  ];
  if (opts.variant === "commentary") issues.push(...templateEchoCheck(text, opts.templateDraft));
  issues.push(...(await collisionCheck(db, opts.queueId, opts.skeletonHash, opts.openerHash)));
  if (opts.corpusPopulated) issues.push(...(await corpusEchoCheck(db, text)));
  return issues;
}
