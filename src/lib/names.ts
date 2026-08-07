// p6-01 (A1): filed-name -> display-name normalization.
//
// EDGAR stores reporting-owner names as `LAST FIRST MIDDLE`, so the desk has
// been shipping "Blecharczyk Nathan", "FALTISCHEK DENISE M" and "Merton Carl
// A" on live cards. This module derives ONE display string from the filed
// string. The filed string always stays on the payload; nothing here replaces
// the record, it only decides how the record is printed.
//
// THE GOVERNING INSTINCT IS FAIL-SAFE-TOWARD-NOT-FLIPPING (owner, A1). A wrong
// flip invents an identity. An unflipped name is only ugly. Every ambiguous
// case therefore resolves to `as-filed`, never to a guess.
//
// THE ONE WAY TO MISUSE THIS MODULE: call it on a name that is ALREADY in
// natural order. `deriveDisplayName("Jane Doe")` returns "Doe Jane", and it is
// right to, because its whole premise is that the input is filed LAST FIRST.
// It cannot tell the two apart and no heuristic can. So it belongs only at
// sites whose source convention is KNOWN — EDGAR's `rptOwnerName` and Form
// 144's `nameOfPersonForWhoseAccount...`, both verified 2026-08-07. Anywhere
// else it silently corrupts. (This is not hypothetical: form4.test.ts carried
// fixtures in natural order, and they had to be rewritten to the shape the
// parser actually receives before they tested anything real.)
//
// The corpus this was built and tested against is real, not invented: 49
// distinct reporting-owner names pulled live from 60 current Form 4 filings on
// 2026-08-07, plus the six shapes the owner named. See
// docs/verification/2026-08-07-p6-01-name-corpus.md.

/** What the classifier decided. Recorded on the payload for audit. */
export type NameShape = "person" | "entity" | "as-filed";

export interface DisplayName {
  /** The string templates, beats and prompts print. */
  display: string;
  /** Which branch produced it. */
  shape: NameShape;
}

// ---------------------------------------------------------------------------
// Classification

/**
 * Tokens that make a filed name an ENTITY. An entity is never reordered.
 *
 * Observed in real filings this list must catch: `THE FORTUNA TRUST U/T/A DTD
 * 06/01/2018`, `GIC Private Ltd`, `Refo SCSp`, `Tractors & Farm Equipment
 * Ltd`, `TAFE Motors & Tractors Ltd`, `Robinhood Markets, Inc.`, `DONEGAL
 * MUTUAL INSURANCE CO`, `Sit Investment Associates, Inc.`.
 *
 * Matching is on WHOLE TOKENS with punctuation stripped, so `Inc.` matches
 * `INC` and a surname merely containing those letters does not. The list is
 * deliberately generous: a false ENTITY costs a reorder we would have liked,
 * a false PERSON invents an identity.
 */
const ENTITY_TOKENS = new Set([
  "TRUST", "TRUSTEE", "TRUSTEES", "TR", "UTA", "UA", "DTD", "DATED", "ESTATE",
  "LLC", "LLP", "LP", "LTD", "LIMITED", "INC", "INCORPORATED", "CORP", "CORPORATION",
  "CO", "COMPANY", "COMPANIES", "PLC", "GMBH", "AG", "NV", "BV", "SA", "SAS", "SCSP",
  "PTE", "PTY", "SARL", "SPA", "OY", "AB", "AS", "KK", "SLP", "SCA", "SICAV",
  "FUND", "FUNDS", "PARTNERS", "PARTNERSHIP", "PARTNER", "CAPITAL", "GROUP", "HOLDING",
  "HOLDINGS", "MANAGEMENT", "MANAGEMENTS", "ADVISORS", "ADVISERS", "ADVISORY",
  "ASSOCIATES", "FOUNDATION", "ENDOWMENT", "PENSION", "PLAN", "SYSTEM",
  "INVESTMENT", "INVESTMENTS", "INVESTORS", "VENTURES", "VENTURE", "EQUITY", "ASSET",
  "ASSETS", "SECURITIES", "BANK", "BANCORP", "BANCSHARES", "INSURANCE", "REALTY",
  "TECHNOLOGIES", "INDUSTRIES", "ENTERPRISES", "INTERNATIONAL", "WORLDWIDE",
]);

/** Multi-character legal markers that survive token-splitting.
 *
 *  Parentheses earn their place from live data: `YUCCA (JERSEY) SLP` and
 *  `INDEX VENTURES GROWTH III (JERSEY), L.P.` are both real production filers,
 *  and a jurisdiction in brackets is something no natural person's name has. */
const ENTITY_MARKERS = ["U/T/A", "U/A", "U/W", "&", "/", "(", ")"];

/** Suffixes that stay at the END of a person's display name. */
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V", "VI"]);

/**
 * Surname particles. In `LAST FIRST` order these LEAD the string and belong to
 * the surname: `Van Der Berg John` is John Van Der Berg, not Berg John Van Der.
 */
const PARTICLES = new Set([
  "VAN", "VON", "DE", "DEL", "DELLA", "DER", "DEN", "DI", "DA", "DU", "DOS", "DAS",
  "LA", "LE", "TEN", "TER", "ST", "SAINT", "AL", "BIN", "IBN",
]);

/** Strip the punctuation that decorates a token without changing its identity. */
function bare(token: string): string {
  return token.replace(/[.,'"()]/g, "").toUpperCase();
}

function looksLikeEntity(filed: string): boolean {
  const upper = filed.toUpperCase();
  if (/\d/.test(filed)) return true; // dates, series numbers, fund numbers
  for (const marker of ENTITY_MARKERS) if (upper.includes(marker)) return true;
  return filed.split(/\s+/).some((t) => ENTITY_TOKENS.has(bare(t)));
}

// ---------------------------------------------------------------------------
// Casing
//
// TWO RULES, and between them they need no dictionary of surnames.
//
// 1. A filing written ENTIRELY IN CAPS carries no casing information, so every
//    token is rebuilt: `FALTISCHEK DENISE M` -> `Denise M. Faltischek`.
// 2. A filing that already MIXES case chose its casing, so tokens are left
//    byte-for-byte alone: `McNulty`, `DeLuca`, `O'Brien`, `Lee-Lean`, `GIC`,
//    `TAFE` and `SCSp` all survive untouched.
//
// Lowercasing a mixed-case token and re-capitalizing it would have produced
// `Mcnulty` and `Deluca` — destroying information the filing actually carried,
// which is the same class of error as inventing it.
//
// The one exception inside rule 2 is a LONG all-caps token sitting in an
// otherwise mixed string (`FALTISCHEK Denise`). Five characters is the
// threshold because it clears every acronym in the live corpus (`GIC`, `TAFE`)
// while catching a shouted surname. This is cosmetic in both directions; no
// identity turns on it.

const ACRONYM_MAX = 4;
const ROMAN = /^(?:II|III|IV|VI?)$/;
/** `E.J.`, `J.R.` — a run of dotted initials, which must not be lowercased. */
const DOTTED_INITIALS = /^(?:[A-Za-z]\.){2,}$/;

/**
 * Capitalize the first LETTER, not the first character.
 *
 * Live defect: `(JERSEY),` capitalized at index 0 hits the bracket, so the
 * whole word lowercased to `(jersey),` on a real production filer name.
 */
function capitalize(word: string): string {
  const i = word.search(/[A-Za-z]/);
  if (i === -1) return word;
  return word.slice(0, i) + word[i]!.toUpperCase() + word.slice(i + 1).toLowerCase();
}

/** Rebuild ONE token whose casing carries no information. */
function foldToken(token: string): string {
  const b = bare(token);
  if (ROMAN.test(b)) return b; // III, IV — never "Iii"
  if (DOTTED_INITIALS.test(token)) return token.toUpperCase(); // E.J.
  // Mc, and only Mc. "MACK" must not become "MacK", and there is no safe rule
  // for Mac that a dictionary would not have to settle.
  if (/^MC[A-Z]{2,}$/.test(token.toUpperCase())) {
    return `Mc${capitalize(token.toUpperCase().slice(2))}`;
  }
  return token
    .split(/([-'’])/)
    .map((part, i) => (i % 2 === 1 ? part : capitalize(part)))
    .join("");
}

function isAllCaps(s: string): boolean {
  return /[A-Z]/.test(s) && !/[a-z]/.test(s);
}

/**
 * Case one token, given whether the WHOLE filed string was shouted.
 * Exported for the tests that pin rule 2.
 */
export function caseToken(token: string, wholeStringIsAllCaps: boolean): string {
  if (wholeStringIsAllCaps) return foldToken(token);
  if (isAllCaps(token) && bare(token).length > ACRONYM_MAX) return foldToken(token);
  return token;
}

// ---------------------------------------------------------------------------
// Person assembly

/** A single letter, with or without its period: the middle-initial shape. */
function isInitial(token: string): boolean {
  return /^[A-Za-z]\.?$/.test(token);
}

/**
 * IS THIS NAME ALREADY IN NATURAL ORDER? Measured, not assumed.
 *
 * EDGAR's field convention is `LAST FIRST MIDDLE`, but a minority of filer
 * agents ignore it and type the name the human way. Both shapes are in
 * production right now: `Nigel W. Morris`, `KEVIN J. KRAUS` and `Paul B.
 * Murphy Jr.` are natural, while `Merton Carl A` and `Ponder L Barbee IV` are
 * EDGAR-ordered. Flipping the first group invents a person.
 *
 * The separating signal is structural. In EDGAR order the initial is a MIDDLE
 * name, so it lands LAST (`Merton Carl A`, `Dhillon Mannik S.`). In natural
 * order the initial is the middle name in its natural slot, so it sits BETWEEN
 * two full names — and a filer typing a name the human way punctuates it.
 *
 * A bare middle initial does NOT trigger this: `Ponder L Barbee IV` is EDGAR
 * order with `L` as the given name, and it is the counterexample that stops
 * the rule at "with a period". Checked against all 115 distinct filer names in
 * production on 2026-08-07: zero false positives, zero false negatives.
 *
 * This only ever SUPPRESSES a flip, so being wrong leaves a name ugly rather
 * than reassigned — the direction A1 requires.
 */
function looksNaturalOrder(core: string[]): boolean {
  if (core.slice(1, -1).some((t) => /^[A-Za-z]\.$/.test(t))) return true;
  return leadsWithGivenName(core);
}

/**
 * The second natural-order signal, for the shapes the period rule cannot see.
 *
 * `KATHERINE ANN MAHER`, `Mat Ishbia` and `David Zeiden` are real production
 * filers in natural order with no punctuation to give them away, and the flip
 * turns them into `Ann Maher Katherine`, `Ishbia Mat` and `Zeiden David` —
 * three people who do not exist.
 *
 * THIS LIST IS NOT AN AUTHORITY AND IT NEVER CREATES A FLIP. It can only
 * withhold one, so a name missing from it falls back to EDGAR's documented
 * convention (the right answer for the large majority) and a name wrongly on
 * it merely stays unflipped. Every failure it can cause is the ugly kind.
 *
 * Two guards keep it narrow:
 *  - it needs the FIRST token to be a known given name and the LAST token NOT
 *    to be, which is exactly the natural-order signature. `Sheena Jonathan`
 *    and `Harrison Gina` have a given name at both ends, so they still flip.
 *  - it never fires when the last token is an INITIAL, because that is already
 *    conclusive EDGAR order. `Stewart Frank P.` flips despite `Stewart` being
 *    a perfectly good given name.
 */
const GIVEN_NAMES = new Set(
  (
    "james robert john michael david william richard joseph thomas charles christopher daniel matthew " +
    "anthony mark donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward " +
    "jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin " +
    "samuel gregory alexander patrick frank raymond jack dennis jerry tyler aaron jose adam nathan " +
    "henry zachary douglas peter kyle noah ethan jeremy walter christian keith roger terry austin sean " +
    "gerald carl harold dylan arthur lawrence jordan jesse bryan billy bruce gabriel joe logan alan " +
    "juan albert willie elijah wayne randy vincent mason roy ralph bobby russell bradley philip eugene " +
    "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa margaret betty " +
    "sandra ashley dorothy kimberly emily donna michelle carol amanda melissa deborah stephanie rebecca " +
    "sharon laura cynthia amy kathleen angela shirley anna brenda pamela nicole ruth katherine samantha " +
    "christine emma catherine debra virginia rachel carolyn janet maria heather diane julie joyce " +
    "victoria kelly christina joan evelyn lauren judith olivia frances martha cheryl megan andrea hannah " +
    "jacqueline ann jean alice kathryn gloria teresa doris sara janice julia marie madison grace judy " +
    "abigail marilyn beverly danielle theresa sophia marlene diana brittany natalie isabella charlotte " +
    "rose alexis kayla anat mat ishaan priya rahul vijay amrita nina jayshree tomer katja olivia seamus"
  ).split(" "),
);

function leadsWithGivenName(core: string[]): boolean {
  if (core.length < 2) return false;
  const first = bare(core[0]!).toLowerCase();
  const last = core[core.length - 1]!;
  if (isInitial(last)) return false; // conclusive EDGAR order; the list stays out of it
  return GIVEN_NAMES.has(first) && !GIVEN_NAMES.has(bare(last).toLowerCase());
}

/** `Carl A` becomes `Carl A.` — the period is typography on the same token,
 *  not a new claim (owner, A1). An initial that already has one is untouched. */
function withPeriod(token: string): string {
  return /^[A-Za-z]$/.test(token) ? `${token.toUpperCase()}.` : token;
}

/**
 * A confident person shape: 2 to 4 tokens (owner, A1).
 *
 * One token cannot be reordered at all, and five or more is far likelier to be
 * an unflagged institution than a person with four given names — so both ends
 * fall through to as-filed rather than guess.
 */
function isPersonShape(tokens: string[]): boolean {
  return tokens.length >= 2 && tokens.length <= 4;
}

/** `JR` -> `Jr.`, `III` -> `III`. Roman numerals never take a period. */
function suffixDisplay(token: string): string {
  const b = bare(token);
  return ROMAN.test(b) ? b : `${capitalize(b)}.`;
}

// ---------------------------------------------------------------------------
// Entity assembly

/**
 * Trim the legal boilerplate tail so a card can print the entity (owner, A1).
 *
 * `THE FORTUNA TRUST U/T/A DTD 06/01/2018` renders as `The Fortuna Trust`. The
 * full filed string stays on the payload; this shortens only the DISPLAY, and
 * the cut is at the first boilerplate marker so nothing before it is lost.
 */
const TAIL_MARKERS = /\s+(?:U\/T\/A|U\/A|U\/W|UTA\b|DTD\b|DATED\b|TR\s+UA\b)/i;

// ---------------------------------------------------------------------------

/**
 * What the FILING says about the owner, when the caller has it.
 *
 * The keyword list cannot catch an entity whose name is two ordinary words —
 * `Pershing Square`, `Bender Investment` without its `Company` — and flipping
 * one of those invents an identity, the exact failure A1 forbids. Form 4
 * carries the answer for free in `reportingOwnerRelationship`: an officer or a
 * director is a natural person by definition, while a filer marked ONLY as a
 * 10% owner is as often a fund as a human.
 *
 * So the flags do not license a flip; they RELEASE one. Without a positive
 * natural-person signal, a two-token keyword-free name stays as filed.
 */
export interface OwnerRoleHint {
  isOfficer?: boolean;
  isDirector?: boolean;
}

function naturalPersonSignal(hint?: OwnerRoleHint): boolean {
  return hint === undefined || hint.isOfficer === true || hint.isDirector === true;
}

/**
 * Derive the display form of a filed name.
 *
 * Never throws, and never returns an empty display for a non-empty input: the
 * worst case is the filed string in title case, which is exactly the fail-safe
 * the owner specified.
 */
export function deriveDisplayName(filed: string, hint?: OwnerRoleHint): DisplayName {
  const trimmed = (filed ?? "").trim().replace(/\s+/g, " ");
  if (trimmed === "") return { display: "", shape: "as-filed" };
  const caps = isAllCaps(trimmed);
  const cased = (t: string) => caseToken(t, caps);

  if (looksLikeEntity(trimmed)) {
    const display = (trimmed.split(TAIL_MARKERS)[0] ?? trimmed)
      .trim()
      .replace(/[\s,]+$/, "")
      .split(" ")
      .map(cased)
      .join(" ");
    return { display, shape: "entity" };
  }

  const tokens = trimmed.split(" ");
  const asFiled = (): DisplayName => ({ display: tokens.map(cased).join(" "), shape: "as-filed" });
  if (!isPersonShape(tokens)) return asFiled();
  // A bare two-token name is the shape a keyword-free institution wears, so it
  // needs the filing to vouch for a human before it may be reordered.
  if (tokens.length === 2 && !naturalPersonSignal(hint)) return asFiled();

  // Suffix comes off the tail FIRST so it is never mistaken for a given name.
  // `TABACCO JOSEPH J JR` -> suffix JR, leaving `TABACCO JOSEPH J`.
  const suffixes: string[] = [];
  const core = tokens.slice();
  while (core.length > 2 && SUFFIXES.has(bare(core[core.length - 1]!))) {
    suffixes.unshift(core.pop()!);
  }

  // Already human-ordered? Then print it as filed (with its suffix restored)
  // rather than reversing a name that was never reversed. The middle initial
  // still takes its period — that is typography on an unmoved token, and
  // `GEORGE H POSTE` should read `George H. Poste` either way. The last token
  // is a surname and never takes one.
  if (looksNaturalOrder(core)) {
    const kept = core.map((t, i) =>
      i > 0 && i < core.length - 1 && isInitial(t) ? withPeriod(cased(t)) : cased(t),
    );
    return { display: [...kept, ...suffixes.map(suffixDisplay)].join(" "), shape: "as-filed" };
  }

  // Leading particles belong to the surname, which is filed first. The loop
  // stops one short of the end so a name can never lose its given name.
  let surnameLen = 1;
  while (surnameLen < core.length - 1 && PARTICLES.has(bare(core[surnameLen - 1]!))) {
    surnameLen += 1;
  }
  const surname = core.slice(0, surnameLen);
  const given = core.slice(surnameLen);
  if (given.length === 0) return asFiled();

  const givenOut = given.map((t) => (isInitial(t) ? withPeriod(cased(t)) : cased(t)));
  // A particle renders lowercase mid-string, the dominant convention (Ludwig
  // van Beethoven, Charles de Gaulle) — but only when the filing shouted it
  // and so expressed no preference of its own.
  const surnameOut = surname.map((t, i) => {
    const isLead = i < surname.length - 1;
    if (isLead && PARTICLES.has(bare(t)) && isAllCaps(t)) return t.toLowerCase();
    return cased(t);
  });

  return {
    display: [...givenOut, ...surnameOut, ...suffixes.map(suffixDisplay)].join(" "),
    shape: "person",
  };
}

/**
 * THE LICENSING PROPERTY, asserted in tests rather than assumed.
 *
 * `entityCheck` licenses any name that appears in the payload JSON, and the
 * payload is where display_name now lives — so the validator cannot be the
 * thing that proves the derivation honest. Its haystack is the very string
 * being added. This predicate is the independent proof: every alphanumeric run
 * in the display must come from an alphanumeric run in the filed string.
 * Reordering, case-folding, lowering a particle, adding a period and dropping a
 * boilerplate tail all preserve it. Inventing a token does not.
 */
export function displayIsDerivable(filed: string, display: string): boolean {
  const runs = (s: string) => s.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const filedRuns = new Set(runs(filed));
  return runs(display).every((r) => filedRuns.has(r));
}
