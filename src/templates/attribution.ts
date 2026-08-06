/**
 * THE ATTRIBUTION TABLE (owner ruling 2026-08-06, item 2).
 *
 * ONE PINNED PLAIN-ENGLISH DISPLAY STRING PER SOURCE. Internal system names
 * are ALIASES: still accepted on text that already carries them, never
 * emitted. "eFD" is the case that forced the rule — it is the Senate's
 * internal name for its filing system and means nothing to a reader, so the
 * pinned form is "per Senate financial disclosures" and "per Senate eFD"
 * survives only as an alias on legacy drafts.
 *
 * THE OTHER HALF OF THE RULING: attribution is satisfied when the publishing
 * source IS the named actor of the fact line ("The FTC just sued...", "A
 * company just told the SEC..."). A trailing "per X" is required only when
 * source and actor differ. `actors` is the list of names that count as that
 * embedded form.
 *
 * `actors` is DELIBERATELY EMPTY for the disclosure systems (CONGRESS_PTR).
 * The Senate's and the House's filing systems publish; they never act. If
 * bare "Senate" counted as embedded attribution, every draft opening "Senate
 * PTR:" would satisfy the rule by naming its own archetype, and the citation
 * requirement would evaporate. An empty list is the guard, not an omission.
 *
 * Leaf module: imports nothing. templates/archetypes reads it, and a cycle
 * through ingesters would deadlock module init (same law as
 * ingesters/rateAttribution).
 */

export interface AttributionEntry {
  /** The pinned form. The renderer emits this and nothing else. */
  readonly display: string;
  /** Accepted-but-never-emitted forms: legacy pins, internal system names. */
  readonly aliases: readonly string[];
  /**
   * Names that, appearing in the fact block, ARE the attribution. Empty means
   * this source can never be the actor of a fact it publishes.
   */
  readonly actors: readonly string[];
}

const E = (
  display: string,
  opts: { aliases?: readonly string[]; actors?: readonly string[] } = {},
): AttributionEntry => ({
  display,
  aliases: opts.aliases ?? [],
  actors: opts.actors ?? [],
});

/**
 * Every attribution this desk may print. Grouped the way the sources group.
 *
 * JARGON SWEEP, 2026-08-06: the eFD-class pins found in this table are listed
 * in docs/verification/2026-08-06-v2-copy-law.md with a proposed plain
 * form for each. Only the two the owner ruled on are changed here; the rest
 * are proposals awaiting a ruling, and changing a pin on my own authority is
 * exactly the drift this file exists to stop.
 */
const ENTRIES: readonly AttributionEntry[] = [
  // --- SEC and its documents ------------------------------------------------
  E("per SEC", { actors: ["SEC", "Securities and Exchange Commission"] }),
  E("per SEC Form 4", { actors: ["SEC"] }),
  E("per SEC Form 144", { actors: ["SEC"] }),
  E("per SEC Form 4 filings", { actors: ["SEC"] }),

  // --- Congressional disclosure (actors: NONE, see the file header) ---------
  E("per Senate financial disclosures", { aliases: ["per Senate eFD"] }),
  E("per the House Clerk", { aliases: ["per House Clerk"] }),

  // --- US agencies ----------------------------------------------------------
  E("per BLS", { actors: ["BLS", "Bureau of Labor Statistics"] }),
  E("per Federal Reserve", { actors: ["Federal Reserve"] }),
  E("per the Federal Reserve", { actors: ["Federal Reserve"] }),
  E("per US Treasury", { actors: ["US Treasury", "Treasury Department"] }),
  E("per FDA", { actors: ["FDA", "Food and Drug Administration"] }),
  E("per Federal Register"),
  E("per CFTC", { actors: ["CFTC", "Commodity Futures Trading Commission"] }),
  E("per FTC", { actors: ["FTC", "Federal Trade Commission"] }),
  E("per the Justice Department", { actors: ["Justice Department", "DOJ"] }),
  E("per the CFPB", { actors: ["CFPB", "Consumer Financial Protection Bureau"] }),
  E("per GAO", { actors: ["GAO", "Government Accountability Office"] }),
  E("per the BEA", { actors: ["BEA", "Bureau of Economic Analysis"] }),
  E("per the EIA", { actors: ["EIA", "Energy Information Administration"] }),
  E("per the National Hurricane Center", { actors: ["National Hurricane Center"] }),

  // --- Exchanges ------------------------------------------------------------
  E("per Nasdaq", { actors: ["Nasdaq"] }),

  // --- Our own lake ---------------------------------------------------------
  E("per Skeptic's tape"),

  // --- Central banks and overseas regulators --------------------------------
  E("per the Reserve Bank of Australia", { actors: ["Reserve Bank of Australia"] }),
  E("per Banco Central do Brasil", { actors: ["Banco Central do Brasil"] }),
  E("per Bank of Canada", { actors: ["Bank of Canada"] }),
  E("per ECB", { actors: ["ECB", "European Central Bank"] }),
  E("per the Bank of Israel", { actors: ["Bank of Israel"] }),
  E("per Norges Bank", { actors: ["Norges Bank"] }),
  E("per South African Reserve Bank", { actors: ["South African Reserve Bank"] }),
  E("per Sveriges Riksbank", { actors: ["Sveriges Riksbank"] }),
  E("per Swiss National Bank", { actors: ["Swiss National Bank"] }),
  E("per Bank of England", { actors: ["Bank of England"] }),
  E("per the Bank of Japan", { actors: ["Bank of Japan"] }),
  E("per the Reserve Bank of India", { actors: ["Reserve Bank of India", "RBI"] }),
  E("per SEBI", { actors: ["SEBI"] }),
  E("per the Office for National Statistics", { actors: ["Office for National Statistics", "ONS"] }),
  E("per OFSI", { actors: ["OFSI"] }),
  E("per the EBA", { actors: ["EBA", "European Banking Authority"] }),
  E("per the WTO", { actors: ["WTO", "World Trade Organization"] }),
  E("per the CMA", { actors: ["CMA", "Competition and Markets Authority"] }),
  E("per HM Treasury", { actors: ["HM Treasury"] }),
  E("per FINMA", { actors: ["FINMA"] }),
  E("per the FCA", { actors: ["FCA", "Financial Conduct Authority"] }),
  E("per the European Commission", { actors: ["European Commission"] }),
];

const BY_DISPLAY: ReadonlyMap<string, AttributionEntry> = new Map(ENTRIES.map((e) => [e.display, e]));

export function attributionEntry(display: string): AttributionEntry | undefined {
  return BY_DISPLAY.get(display);
}

/**
 * Display + aliases. An entry missing from the table degrades to "the string
 * itself is the only accepted form" — strictly narrower than the old
 * behaviour, so a forgotten registration can never widen what passes.
 */
export function acceptedForms(display: string): readonly string[] {
  const e = BY_DISPLAY.get(display);
  return e ? [e.display, ...e.aliases] : [display];
}

export function actorsFor(display: string): readonly string[] {
  return BY_DISPLAY.get(display)?.actors ?? [];
}

/** Every form this desk accepts anywhere. sourcingCheck's whitelist. */
export const ALL_ATTRIBUTION_FORMS: readonly string[] = ENTRIES.flatMap((e) => [e.display, ...e.aliases]);

/** Exported for the table-completeness test, not for lookup. */
export const ATTRIBUTION_ENTRIES = ENTRIES;

// ---------------------------------------------------------------------------
// Text helpers for the embedded form. They live here, in the leaf, because
// BOTH the renderer (which decides whether to append a citation) and the
// validator (which decides whether one was needed) have to agree about what
// "the source is the actor" means. templates/validate already imports
// templates/render, so the shared rule cannot live in either of those.
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Everything before the first blank line: the block that must stand alone. */
export function factBlockOf(text: string): string {
  const i = text.indexOf("\n\n");
  return i === -1 ? text : text.slice(0, i);
}

/**
 * The text with every "per ..." phrase blanked out.
 *
 * Without this a trailing "per SEC" would itself satisfy the EMBEDDED test
 * and the two forms would be indistinguishable — which is exactly the
 * distinction the redundancy check is built on.
 */
export function withoutPerPhrases(s: string): string {
  return s.replace(/\bper\s+[^.,\n]*/gi, " ");
}

/** Proper nouns, so case-sensitive: `\bSEC\b` must not match "seconds". */
export function namesIn(haystack: string, names: readonly string[]): string[] {
  return names.filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(haystack));
}

/**
 * The source named as the DOER of the LEAD claim: "FTC sued", "RBI releases",
 * "SEC instituted".
 *
 * Two deliberate narrowings, both load bearing.
 *
 * 1. The verb must be LOWERCASE, which excludes the agency's name sitting
 *    inside a title-case headline ("SEC: SEC Charges Two Individuals"). That
 *    form states the source twice, but it is a rendering defect (D-15), not a
 *    copy-law violation, and treating it as one would have refused live press
 *    drafts wholesale.
 *
 * 2. Only the FIRST SENTENCE counts. Found in live data: FDA recall #982
 *    reads "Modern Warrior Life, LLC is recalling product. Class I, reason:
 *    FDA analysis revealed..." — the actor is the firm and the FDA appears
 *    only inside the quoted reason, so scanning the whole line dropped a
 *    citation the post genuinely needed. Source and actor DO differ there.
 */
export function inActorPosition(haystack: string, names: readonly string[]): string[] {
  const lead = haystack.split(/(?<=[.!?])\s/)[0] ?? haystack;
  return names.filter((n) =>
    new RegExp(
      `\\b${escapeRe(n)}\\b\\s+(?:just\\s+|also\\s+|has\\s+|have\\s+|had\\s+)*[a-z]+(?:ed|s)\\b`,
    ).test(lead),
  );
}

/** Does this head line already carry its citation in its subject? */
export function namesSourceAsActor(headLine: string, display: string): boolean {
  return inActorPosition(withoutPerPhrases(headLine), actorsFor(display)).length > 0;
}
