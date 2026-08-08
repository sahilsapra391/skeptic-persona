// p6-01 (A1, revised under B-12): conformed-name -> display-name normalization.
//
// EDGAR's CONFORMED name for a CIK is `LAST FIRST MIDDLE`, and that convention
// is the only thing that licenses a reorder. Free-text document fields are
// NEVER reordered (B-12.3): Form 144's
// `nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold` is typed by the filer
// agent, and on 2026-08-07 it disagreed with EDGAR's own conformed name in 25
// of 87 comparable filings. Feeding it here produced `D. Miller Kendra` for a
// person EDGAR conforms as `Miller Kendra D`.
//
// Callers pass `conformed: false` for anything not conformed, and this module
// then only cases the string. See `deriveDisplayName`.
//
// THE GOVERNING INSTINCT IS FAIL-SAFE-TOWARD-NOT-FLIPPING (owner, A1), and
// B-12.4(a) sharpened it: where no signal separates two readings, DO NOT
// GUESS — render as filed. Suppression is the designed outcome, not a failure.
// The invariant at the bottom of `deriveDisplayName` makes it impossible for
// any path, suppressing or not, to emit a token the filing did not contain.
//
// Every rule below is attributed to the real filer that forced it. Nothing
// here is defensive programming against a hypothetical.

/** What the classifier decided. Recorded on the payload for audit. */
export type NameShape = "person" | "entity" | "as-filed";

export interface DisplayName {
  /** The string templates, beats and prompts print. */
  display: string;
  /** Which branch produced it. */
  shape: NameShape;
}

export interface DeriveOptions {
  /**
   * Is this string EDGAR's conformed name for the CIK? Only a conformed name
   * may be reordered (B-12.3). Defaults to FALSE so a caller that has not
   * thought about it gets the safe behaviour.
   */
  conformed?: boolean;
  /** What the filing says about the owner; see `naturalPersonSignal`. */
  isOfficer?: boolean;
  isDirector?: boolean;
}

// ---------------------------------------------------------------------------
// Classification

/**
 * Tokens that make a filed name an ENTITY. An entity is never reordered.
 *
 * `UTA`, `UA` and `TR` were removed after `SCHMIDT UTA` — a real person —
 * classified as a trust and rendered as the single word `Schmidt`, deleting
 * her given name from the card. Trust detection now rests on the punctuated
 * `U/T/A` marker and on `DTD`, which no given name collides with.
 */
const ENTITY_TOKENS = new Set([
  "TRUST", "TRUSTEE", "TRUSTEES", "ESTATE", "DTD", "DATED", "FAMILY", "FOUNDATION",
  "LLC", "LLP", "LLLP", "PLLC", "LP", "LC", "GP", "LTD", "LIMITED",
  "INC", "INCORPORATED", "CORP", "CORPORATION", "COMPANY", "COMPANIES", "CO",
  "PLC", "GMBH", "AG", "NV", "BV", "SA", "SAS", "SCSP", "SCA", "SICAV", "SARL",
  "PTE", "PTY", "SPA", "OY", "AB", "KK", "SLP",
  "FUND", "FUNDS", "PARTNERS", "PARTNERSHIP", "PARTNER", "CAPITAL", "GROUP",
  "HOLDING", "HOLDINGS", "MANAGEMENT", "ADVISORS", "ADVISERS", "ADVISORY",
  "ASSOCIATES", "ENDOWMENT", "PENSION", "PLAN", "SYSTEM",
  "INVESTMENT", "INVESTMENTS", "INVESTORS", "VENTURES", "VENTURE", "EQUITY",
  "ASSET", "ASSETS", "SECURITIES", "BANK", "BANCORP", "BANCSHARES", "INSURANCE",
  "REALTY", "TECHNOLOGIES", "INDUSTRIES", "ENTERPRISES", "INTERNATIONAL",
]);

/** Legal forms that stay upper-case when an all-caps entity is folded.
 *  `EQUINOX PARTNERS LP` read as `Equinox Partners Lp` before this. */
const LEGAL_FORMS_UPPER = new Set(["LLC", "LLP", "LLLP", "PLLC", "LP", "LC", "GP", "PLC", "SA", "NV", "BV", "AG", "SCSP"]);

/** Multi-character legal markers that survive token-splitting. Brackets come
 *  from `YUCCA (JERSEY) SLP`; no natural person carries a jurisdiction. */
const ENTITY_MARKERS = ["U/T/A", "U/A", "U/W", "&", "/", "(", ")"];

/**
 * Suffixes that stay at the END of a person's display name.
 *
 * `V` is deliberately absent. `TAYLOR THOMAS V` is Thomas V. Taylor, and
 * treating the bare `V` as a generational numeral printed `Thomas Taylor V`
 * while every other middle initial rendered correctly. A single-letter roman
 * numeral is a middle initial far more often than a suffix; `II`, `III`, `IV`
 * and `VI` are unambiguous and stay.
 */
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "VI"]);
const ROMAN = /^(?:II|III|IV|VI)$/;

/** Post-nominal credentials. `Flammer Martina M.D.` printed the credential as
 *  a middle name (`Martina M.D. Flammer`); `BUCALO LOUIS R MD` gave
 *  `Louis R. Md Bucalo`. They are stripped from the ordering problem and put
 *  back where the filing had them. */
const CREDENTIAL_FORMS: Record<string, string> = {
  MD: "MD", PHD: "PhD", MBA: "MBA", CFA: "CFA", CPA: "CPA", ESQ: "Esq.", JD: "JD",
  DDS: "DDS", DVM: "DVM", DO: "DO", RN: "RN", DR: "Dr.", PE: "PE", CFP: "CFP",
};
const CREDENTIALS = new Set(Object.keys(CREDENTIAL_FORMS));

/** `BUCALO LOUIS R MD` rendered `Louis R. Bucalo Md`. A credential is an
 *  abbreviation with a settled spelling, so it gets that spelling rather than
 *  the generic title-case pass. Adding the period to `Dr.`/`Esq.` is the same
 *  typography licence as the middle-initial period. */
function credentialDisplay(token: string): string {
  const canon = CREDENTIAL_FORMS[bare(token)];
  if (canon === undefined) return token;
  // Adopt the canonical spelling ONLY when it preserves the filed letter-runs.
  // `M.D.` -> `MD` merges two runs into one and the module's own invariant
  // rejects it (correctly — it is a different string, not a re-casing), so a
  // dotted credential keeps its dots and is merely upper-cased. `DR` -> `Dr.`
  // is fine because a period is not a letter and the runs are untouched.
  const runs = (s: string) => (s.toUpperCase().match(/[A-Z]+/g) ?? []).join("|");
  return runs(canon) === runs(token) ? canon : token.toUpperCase();
}

/**
 * Surname particles. In `LAST FIRST` order these LEAD the string and belong to
 * the surname: `VAN HALEN EDWARD` is Edward van Halen.
 *
 * `ST` and `SAINT` are here for grouping but never lower-cased — `ST JOHN
 * JONELLE` rendered as `Jonelle st John`, and Saint is always capitalised.
 */
const PARTICLES = new Set([
  "VAN", "VON", "DE", "DEL", "DELLA", "DER", "DEN", "DI", "DA", "DU", "DOS", "DAS",
  "LA", "LE", "TEN", "TER", "ST", "SAINT", "AL", "BIN", "IBN",
]);
const NEVER_LOWERED = new Set(["ST", "SAINT"]);

/**
 * EDGAR strips apostrophes and leaves the fragment as its own token, so
 * `O'Brien` is conformed as `O BRIEN` and `D'Amato` as `D AMATO`. Read as a
 * lone surname token, `O BRIEN DANIEL B` became `Brien Daniel B. O`.
 *
 * The apostrophe is NOT put back. Re-inserting a character the filing does not
 * contain is exactly the line this module does not cross, so the display is
 * `Daniel B. O Brien`: ugly, and every token from the record.
 */
const APOSTROPHE_PREFIXES = new Set(["O", "D", "L"]);

/** `Mc Carthy Liam` is a live reporting owner: EDGAR space-splits Mc and Mac
 *  surnames too, and read as a lone token it promoted half the surname to a
 *  given name. */
const SURNAME_LEAD = new Set(["MC", "MAC"]);

/** Does the first token begin a surname that continues into the next token?
 *  Particles, apostrophe fragments and Mc/Mac all do, and none of them may be
 *  handed to `ambiguousSurname` — the multi-word surname is already explained. */
function startsMultiTokenSurname(core: string[]): boolean {
  const first = bare(core[0] ?? "");
  if (core.length < 3) return false;
  if (PARTICLES.has(first)) return true;
  if (SURNAME_LEAD.has(first)) return true;
  return APOSTROPHE_PREFIXES.has(first) && (core[0] ?? "").length <= 2 && isInitial(core[core.length - 1]!);
}

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

const ACRONYM_MAX = 4;
/** `E.J.`, `J.R.`, `G.M.` — a run of dotted initials, never lower-cased. */
const DOTTED_INITIALS = /^(?:[A-Za-z]\.){2,}$/;

/** Capitalize the first LETTER, Unicode-aware. `(JERSEY),` capitalized at
 *  index 0 hit the bracket and lower-cased the word; `ÖZTÜRK` put the capital
 *  on the second character and gave `ÖZtürk`. */
function capitalize(word: string): string {
  const i = word.search(/\p{L}/u);
  if (i === -1) return word;
  return word.slice(0, i) + word[i]!.toLocaleUpperCase() + word.slice(i + 1).toLocaleLowerCase();
}

/** Rebuild ONE token whose casing carries no information. */
function foldToken(token: string): string {
  const b = bare(token);
  if (ROMAN.test(b) || b === "V") return b;
  if (LEGAL_FORMS_UPPER.has(b)) return token.toUpperCase();
  if (DOTTED_INITIALS.test(token)) return token.toUpperCase();
  // Mc, and only Mc. "MACK" must not become "MacK", and there is no safe rule
  // for Mac that a dictionary would not have to settle.
  if (/^MC[A-Z]{2,}$/.test(token.toUpperCase())) {
    return `Mc${capitalize(token.toUpperCase().slice(2))}`;
  }
  // Splits on every separator that lives INSIDE a real name or entity token.
  // `R&G CAPITAL` folded to `R&g Capital` before `&` and `/` were included.
  return token
    .split(/([-'’&/])/)
    .map((part, i) => (i % 2 === 1 ? part : capitalize(part)))
    .join("");
}

function isAllCaps(s: string): boolean {
  return /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
}

/**
 * Case one token, given whether the WHOLE filed string was shouted.
 *
 * An ALL-CAPS filing carries no case information and is rebuilt. A filing that
 * already mixes case chose its casing and is left byte-for-byte alone, which
 * is what keeps `McNulty`, `DeLuca`, `O'Brien`, `Lee-Lean`, `GIC`, `TAFE` and
 * `SCSp` correct without a dictionary of surnames.
 */
export function caseToken(token: string, wholeStringIsAllCaps: boolean): string {
  if (wholeStringIsAllCaps) return foldToken(token);
  if (isAllCaps(token) && bare(token).length > ACRONYM_MAX) return foldToken(token);
  return token;
}

// ---------------------------------------------------------------------------
// Token shapes

/** A single letter, with or without its period. */
function isInitial(token: string): boolean {
  return /^\p{L}\.?$/u.test(token);
}

/** `Carl A` becomes `Carl A.` — typography on an unmoved token, not a claim. */
function withPeriod(token: string): string {
  return /^\p{L}$/u.test(token) ? `${token.toLocaleUpperCase()}.` : token;
}

function isCredential(token: string): boolean {
  return CREDENTIALS.has(bare(token));
}

/** `JR` -> `Jr.`, `III` -> `III`. Roman numerals never take a period. */
function suffixDisplay(token: string): string {
  const b = bare(token);
  return ROMAN.test(b) ? b : `${capitalize(b.toLowerCase())}.`;
}

// ---------------------------------------------------------------------------
// The given-name list
//
// IT IS NOT AN AUTHORITY AND IT NEVER CREATES A FLIP. Every use below can only
// WITHHOLD one, so a name missing from it falls back to EDGAR's convention and
// a name wrongly on it merely stays unflipped. Every failure it can cause is
// the ugly kind, which is the direction B-12.4(a) requires.

const GIVEN_NAMES = new Set(
  (
    "james robert john michael david william richard joseph thomas charles christopher daniel matthew " +
    "anthony mark donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward " +
    "jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin " +
    "samuel gregory alexander patrick frank raymond jack dennis jerry tyler aaron jose adam nathan " +
    "henry zachary douglas peter kyle noah ethan jeremy walter christian keith roger terry austin sean " +
    "gerald carl harold dylan arthur lawrence jordan jesse bryan billy bruce gabriel joe logan alan " +
    "juan albert willie elijah wayne randy vincent mason roy ralph bobby russell bradley philip eugene " +
    "louis todd craig alex marc marcus martin glenn dean neil ian simon brady rajeev biju aman luke " +
    "torsten gianluca jurgi yves ambaw udi nishan efstathios ravi claire jugal zhenyu marino kendra " +
    "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa margaret betty " +
    "sandra ashley dorothy kimberly emily donna michelle carol amanda melissa deborah stephanie rebecca " +
    "sharon laura cynthia amy kathleen angela shirley anna brenda pamela nicole ruth katherine samantha " +
    "christine emma catherine debra virginia rachel carolyn janet maria heather diane julie joyce " +
    "victoria kelly christina joan evelyn lauren judith olivia frances martha cheryl megan andrea hannah " +
    "jacqueline ann jean alice kathryn gloria teresa doris sara janice julia marie madison grace judy " +
    "abigail marilyn beverly danielle theresa sophia marlene diana brittany natalie isabella charlotte " +
    "rose alexis kayla anat mat priya rahul vijay amrita nina jayshree tomer katja seamus vanessa " +
    "janey karalyn jonelle caryn martina gerald ozzy angus liam"
  ).split(" "),
);

const isGiven = (t: string) => GIVEN_NAMES.has(bare(t).toLowerCase());

/**
 * IS THIS ALREADY IN NATURAL ORDER? Three signals, all suppression-only.
 *
 * 1. A PERIODLED MIDDLE INITIAL. In EDGAR order the initial is a middle name
 *    and lands LAST (`Merton Carl A`, `Dhillon Mannik S.`); in natural order it
 *    sits between two full names and a filer typing the human way punctuates
 *    it (`Nigel W. Morris`, `KEVIN J. KRAUS`). `Ponder L Barbee IV` is the
 *    counterexample that stops the rule at "with a period" — there the bare
 *    `L` is the given name.
 * 2. A LEADING INITIAL with a full last token. `R BENTLEY OFFUTT` and
 *    `C FREDERICK LANE` are natural; `O BRIEN DANIEL B` is not, and the
 *    trailing initial is what separates them.
 * 3. A LEADING GIVEN NAME with a non-given last token, for the shapes with no
 *    punctuation at all (`KATHERINE ANN MAHER`, `Mat Ishbia`).
 */
function looksNaturalOrder(core: string[]): boolean {
  if (core.length < 2) return false;
  if (core.slice(1, -1).some((t) => /^\p{L}\.$/u.test(t))) return true;
  const last = core[core.length - 1]!;
  if (isInitial(core[0]!) && !isInitial(last) && !APOSTROPHE_PREFIXES.has(bare(core[0]!))) return true;
  if (isInitial(core[0]!) && !isInitial(last) && core.length > 2) return true;
  if (isInitial(last)) return false; // conclusive EDGAR order
  return isGiven(core[0]!) && !isGiven(last);
}

/**
 * THE AMBIGUITY THAT MUST SUPPRESS (B-12.4a).
 *
 * `Seidman Becker Caryn` is Caryn Seidman-Becker, whose surname is two words.
 * `Adler Jason Marc` is Jason Marc Adler, whose surname is one. The token
 * shapes are identical and EDGAR's conformed name encodes no difference, so
 * there is nothing to read. Guessing produced `Becker Caryn Seidman`, a person
 * who does not exist.
 *
 * The one readable trace: in the two-word-surname case the REAL given name is
 * stranded at the end while position 1 holds the rest of the surname. So
 * suppress when the last token is a given name and position 1 is a full token
 * that is not. `Brau Donnelly Julia` (Julia Brau Donnelly) suppresses too.
 *
 * An INITIAL at position 1 is never this shape — `CUBLEY H DEAN` is H. Dean
 * Cubley — so the rule requires a full token there.
 */
function ambiguousSurname(core: string[]): boolean {
  if (core.length !== 3) return false;
  const [, second, third] = core as [string, string, string];
  if (isInitial(second)) return false;
  return isGiven(third) && !isGiven(second);
}

// ---------------------------------------------------------------------------
// Entity assembly

/** `THE FORTUNA TRUST U/T/A DTD 06/01/2018` renders `The Fortuna Trust`. The
 *  full filed string stays on the payload; this shortens only the DISPLAY. */
const TAIL_MARKERS = /\s+(?:U\/T\/A|U\/A|U\/W|DTD\b|DATED\b)/i;

// ---------------------------------------------------------------------------

/**
 * Derive the display form of a name.
 *
 * Reordering happens ONLY when `conformed` is true (B-12.3). Everything else
 * is cased and returned in the order it arrived.
 */
export function deriveDisplayName(filed: string, opts: DeriveOptions = {}): DisplayName {
  const trimmed = (filed ?? "").trim().replace(/\s+/g, " ");
  if (trimmed === "") return { display: "", shape: "as-filed" };
  const result = derive(trimmed, opts);

  // THE INVARIANT (B-12.4a): no path may emit a token the filing did not
  // contain. Checked here rather than trusted, because every branch above is a
  // heuristic and this is the one thing that must hold for all of them. A
  // violation falls back to the filed string, cased.
  if (!displayIsDerivable(trimmed, result.display)) {
    const caps = isAllCaps(trimmed);
    return { display: trimmed.split(" ").map((t) => caseToken(t, caps)).join(" "), shape: "as-filed" };
  }
  return result;
}

function derive(trimmed: string, opts: DeriveOptions): DisplayName {
  const caps = isAllCaps(trimmed);
  const cased = (t: string) => caseToken(t, caps);
  const tokens = trimmed.split(" ");
  const asFiled = (): DisplayName => ({ display: tokens.map(cased).join(" "), shape: "as-filed" });

  if (looksLikeEntity(trimmed)) {
    const cut = trimmed.split(TAIL_MARKERS)[0]?.trim() ?? trimmed;
    // The cut may never empty the name; `SCHMIDT UTA` once rendered `Schmidt`.
    const body = cut === "" ? trimmed : cut;
    return {
      display: body.replace(/[\s,]+$/, "").split(" ").map(cased).join(" "),
      shape: "entity",
    };
  }

  // NOT CONFORMED = NOT REORDERED (B-12.3). Form 144's free-text seller field
  // lands here and is only cased.
  if (opts.conformed !== true) return asFiled();

  // A confident person shape is 2 to 4 tokens (owner, A1), measured before
  // credentials and suffixes are taken off.
  const credLead: string[] = [];
  const credTail: string[] = [];
  let core = tokens.slice();
  while (core.length > 2 && isCredential(core[0]!)) credLead.push(core.shift()!);
  while (core.length > 2 && isCredential(core[core.length - 1]!)) credTail.unshift(core.pop()!);

  // A SUFFIX IS NOT ALWAYS AT THE END. EDGAR conforms `Zemaitatis Jr. Stephen
  // M` — the suffix binds to the SURNAME, which is filed first, so it lands in
  // the middle. Pulling only from the tail left it in place and the reorder
  // produced `Jr. Stephen M. Zemaitatis`, a name starting with a suffix.
  // Suffixes are collected from anywhere except index 0, where no real name
  // begins, and always render last.
  const suffixes: string[] = [];
  for (let i = core.length - 1; i >= 1 && core.length > 2; i--) {
    if (SUFFIXES.has(bare(core[i]!))) suffixes.unshift(core.splice(i, 1)[0]!);
  }

  if (core.length < 2 || core.length > 4) return asFiled();

  const rebuild = (parts: string[]): DisplayName => ({
    display: [...credLead.map(credentialDisplay), ...parts, ...suffixes.map(suffixDisplay), ...credTail.map(credentialDisplay)].join(" "),
    shape: "person",
  });
  const keepOrder = (): DisplayName => ({
    display: [
      ...credLead.map(credentialDisplay),
      // A leading initial takes its period too: `R BENTLEY OFFUTT` is
      // R. Bentley Offutt. Only the FINAL token is exempt, because there an
      // initial means EDGAR order and this branch would not have been taken.
      ...core.map((t, i) => (i < core.length - 1 && isInitial(t) ? withPeriod(cased(t)) : cased(t))),
      ...suffixes.map(suffixDisplay),
      ...credTail.map(credentialDisplay),
    ].join(" "),
    shape: "as-filed",
  });

  // A bare two-token name is the shape a keyword-free institution wears, so it
  // needs the filing to vouch for a human before it may be reordered.
  const vouched = opts.isOfficer === true || opts.isDirector === true;
  if (core.length === 2 && opts.isOfficer !== undefined && !vouched) return keepOrder();

  if (looksNaturalOrder(core)) return keepOrder();
  if (!startsMultiTokenSurname(core) && ambiguousSurname(core)) return keepOrder();

  // Leading particles belong to the surname, which is filed first. An
  // apostrophe fragment (`O BRIEN`) behaves the same way.
  let surnameLen = 1;
  if (SURNAME_LEAD.has(bare(core[0]!)) && core.length > 2) surnameLen = 2;
  else if (APOSTROPHE_PREFIXES.has(bare(core[0]!)) && core[0]!.length <= 2 && core.length > 2) surnameLen = 2;
  while (surnameLen < core.length - 1 && PARTICLES.has(bare(core[surnameLen - 1]!))) surnameLen += 1;

  const surname = core.slice(0, surnameLen);
  const given = core.slice(surnameLen);
  if (given.length === 0) return keepOrder();

  const givenOut = given.map((t) => (isInitial(t) ? withPeriod(cased(t)) : cased(t)));
  const surnameOut = surname.map((t, i) => {
    const isLead = i < surname.length - 1;
    if (isLead && PARTICLES.has(bare(t)) && !NEVER_LOWERED.has(bare(t)) && isAllCaps(t)) return t.toLowerCase();
    return cased(t);
  });
  return rebuild([...givenOut, ...surnameOut]);
}

/**
 * THE LICENSING PROPERTY, asserted in tests AND enforced above.
 *
 * `entityCheck` licenses any name appearing in the payload JSON, and
 * display_name lives in that JSON — its haystack is the string being added, so
 * it cannot be what proves this honest. This is the independent proof: every
 * letter-or-digit run in the display must come from one in the filed string.
 *
 * UNICODE-AWARE (B-12.5). The regex was `/[A-Z0-9]+/`, ASCII-only, so
 * `displayIsDerivable("Smith John", "Иванов Иван")` returned true — a display
 * sharing not one character with the filed name passed the only honesty check
 * the module had.
 */
export function displayIsDerivable(filed: string, display: string): boolean {
  const runs = (s: string) => s.toLocaleUpperCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const filedRuns = new Set(runs(filed));
  return runs(display).every((r) => filedRuns.has(r));
}
