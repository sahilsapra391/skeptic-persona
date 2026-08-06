import type { Payload } from "../templates/types";

/**
 * THE DEFINITIONS REGISTRY (owner ruling 2026-08-06, item 6).
 *
 * The desk is allowed to explain what a record MEANS, not only what it says.
 * This file is the closed list of things it may explain, each pinned to a
 * primary source. If a draft asserts a rule that is not in here, the rule is
 * not a fact this desk has checked, and the aphorism scorer refuses it.
 *
 * Same law as the attribution table: a payload picks an entry, it can never
 * supply one. Adding a definition means reading the statute or the form and
 * quoting it, not remembering it.
 *
 * VERIFIED means fetched from the issuing body on the stated date, not
 * recalled. Every citation below was retrieved 2026-08-06; the record is
 * docs/verification/2026-08-06-v2-copy-law.md.
 */

export type DefinitionKind =
  /** A published rule: a statute, a regulation, a form instruction. */
  | "rule"
  /** A term whose meaning is a count over our own parsed record. */
  | "record";

export interface DefinitionContext {
  readonly payload: Payload;
  /** Canonical numeric values the payload states (validate.ts PayloadFacts). */
  readonly numbers: ReadonlySet<string>;
}

export interface Definition {
  readonly id: string;
  readonly term: string;
  readonly kind: DefinitionKind;
  /** What the source actually says. Copy may not go past this sentence. */
  readonly statement: string;
  readonly citation: string;
  readonly verifiedAt: string;
  /** Phrases in draft copy that invoke this definition. */
  readonly invokes: readonly RegExp[];
  /**
   * `record` entries only: the claim cashes out to a count, so the count has
   * to be in the payload. A record definition with no support is UNBOUND and
   * the scorer flags it — that is the whole point of the kind split.
   */
  readonly requires?: (ctx: DefinitionContext) => boolean;
}

/** A payload number under a repeat-counting field name, at or above `min`. */
const repeatCountAtLeast =
  (min: number) =>
  ({ payload }: DefinitionContext): boolean =>
    Object.entries(payload).some(
      ([k, v]) => /count|prior|repeat|occurrence|times|filings|streak/i.test(k) && typeof v === "number" && v >= min,
    );

export const DEFINITIONS: readonly Definition[] = [
  {
    id: "ptr-deadline",
    term: "PTR filing deadline and late fee",
    kind: "rule",
    statement:
      "A covered filer must report a transaction over $1,000 within 30 days of being notified of it and in no case later than 45 days after the transaction. Filing more than 30 days after the report was due carries a $200 filing fee.",
    citation:
      "5 U.S.C. § 13106 (fee: “more than 30 days after… shall… pay a filing fee of $200”); reporting duty at 5 U.S.C. § 13104 as amended by the STOCK Act; deadline stated by the House Committee on Ethics (ethics.house.gov PTR guidance).",
    verifiedAt: "2026-08-06",
    invokes: [
      /\b45\s*days?\b[^.\n]{0,40}\b(?:disclose|disclosure|file|filing|report)\b/i,
      /\b(?:deadline|the law gives)\b[^.\n]{0,30}\b45\b/i,
      /\b(?:fine|penalty|fee)\b[^.\n]{0,20}\$200\b/i,
      /\$200\b[^.\n]{0,30}\b(?:fine|penalty|fee|late)\b/i,
    ],
  },
  {
    id: "plan-10b5-1",
    term: "Rule 10b5-1 trading plan",
    kind: "rule",
    statement:
      "A preset written trading plan adopted while not aware of material nonpublic information, giving an affirmative defense to insider-trading liability. For a director or officer no trade may occur until the later of 90 days after adoption or two business days after the issuer discloses results for the quarter of adoption, capped at 120 days, and the filer must certify at adoption that they hold no material nonpublic information and are acting in good faith.",
    citation: "17 CFR § 240.10b5-1(c); amendments adopted SEC Release 33-11138 (2022).",
    verifiedAt: "2026-08-06",
    invokes: [
      /\b10b5-1\b/i,
      /\bpreset trading plan\b/i,
      /\bscheduled\b[^.\n]{0,40}\bplan\b/i,
    ],
  },
  {
    id: "form4-code-p",
    term: "Form 4 transaction code P",
    kind: "rule",
    statement: "P denotes an open market or private purchase of a non-derivative or derivative security.",
    citation:
      "SEC EDGAR Ownership Form Codes, General Transaction Codes: “P - Open market or private purchase of non-derivative or derivative security”.",
    verifiedAt: "2026-08-06",
    invokes: [/\bcode\s*P\b/i, /\bopen[- ]market purchase\b/i],
  },
  {
    id: "form8k-item-402",
    term: "8-K Item 4.02",
    kind: "rule",
    statement:
      "The item an issuer files to report that previously issued financial statements should no longer be relied upon. The issuer selects the item; the conclusion is the issuer's own.",
    citation:
      "SEC Form 8-K, Item 4.02, “Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review”.",
    verifiedAt: "2026-08-06",
    invokes: [
      /\bitem\s*4\.02\b/i,
      /\bno longer be relied (?:up)?on\b/i,
      /\bnon-?reliance\b/i,
      /\bthe numbers were wrong\b/i,
    ],
  },
  {
    id: "insider-communication-constraints",
    term: "What an insider may say about their own trade",
    kind: "rule",
    statement:
      "An issuer, and any senior official or any officer, employee or agent who regularly communicates with market professionals or securityholders, may not selectively disclose material nonpublic information about the issuer without making it public. Form 4 has no field for motive, so the filing states the transaction and nothing about why.",
    citation:
      "17 CFR § 243.100(a) (Regulation FD, general rule on selective disclosure) and § 243.101(c) (definition of “person acting on behalf of an issuer”).",
    verifiedAt: "2026-08-06",
    invokes: [
      /\binsiders?\s+(?:are|is)\s+(?:legally\s+)?(?:allowed|permitted|barred|prohibited)\b/i,
      /\bthe only statement\b[^.\n]{0,30}\binsiders?\b/i,
      /\blegally barred from\b/i,
      /\b(?:says|states) what changed and stops there\b/i,
    ],
  },
  {
    id: "reg-sho-threshold-security",
    term: "Reg SHO threshold security",
    kind: "rule",
    statement:
      "A security with an aggregate fail to deliver position of 10,000 shares or more, equal to at least 0.5% of shares outstanding, for five consecutive settlement days. The five days define the THRESHOLD, not a close-out deadline: mandatory close-out under this section runs on thirteen consecutive settlement days.",
    citation: "17 CFR § 242.203(c)(6) (threshold security) and § 242.203(b)(3) (close-out).",
    verifiedAt: "2026-08-06",
    invokes: [/\bthreshold security\b/i, /\bfails? to deliver\b/i, /\breg(?:ulation)? sho\b/i],
  },
  {
    id: "repeat-count-pattern",
    term: "When a repeat becomes a pattern",
    kind: "record",
    statement:
      "A second occurrence of the same filing type by the same issuer, counted in our own parsed record. The count is the claim; nothing about intent is claimed or implied.",
    citation: "Skeptic's own lake (items table), counted at generation time.",
    verifiedAt: "2026-08-06",
    invokes: [
      /\b(?:one|1)\s+is\s+an?\s+(?:mistake|accident|one-?off)\b/i,
      /\b(?:two|2|second|third)\s+is\s+an?\s+pattern\b/i,
      /\b(?:two|2|second|third)\s+is\s+a\s+pattern\b/i,
    ],
    requires: repeatCountAtLeast(2),
  },
];

const ALL = DEFINITIONS;

/** Every definition whose `invokes` matches somewhere in `text`. */
export function definitionsInvokedBy(text: string): readonly Definition[] {
  return ALL.filter((d) => d.invokes.some((re) => re.test(text)));
}

/**
 * Bound = invoked AND, for a `record` entry, supported by the payload.
 * A rule entry needs no payload: the statute is true whatever we parsed.
 */
export function boundDefinitionsFor(text: string, ctx: DefinitionContext): readonly Definition[] {
  return definitionsInvokedBy(text).filter((d) => d.kind === "rule" || (d.requires?.(ctx) ?? false));
}
