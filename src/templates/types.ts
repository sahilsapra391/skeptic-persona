// Template engine types. Implements docs/persona.md (owner-signed voice
// authority). Design synthesis from the PR-8 judge panel:
// - Gates are DECLARATIVE DATA (inspectable, diffable next to the doc), not
//   code, so beats can be audited and later tuned without reading logic.
// - Every beat MUST carry a gate. There is no defensible ungated beat on a
//   wire account: even doc beats without a bracketed condition imply one
//   ("The lag is the product." requires a parsed lag).
// - Disabled-until-built beats are a DIFFERENT BRANDED TYPE with no gate, so
//   the type checker — not a convention — makes them unrenderable.
// - Slot interpolation fails CLOSED: a missing slot makes the beat
//   ineligible; it never renders blank or zero.

export type ArchetypeId =
  | "FILING_8K"
  | "FILING_FORM4"
  | "INSIDER_NOTICE"
  | "INSIDER_CLUSTER"
  | "CONGRESS_PTR"
  | "MACRO_PRINT"
  | "FED_PRESS"
  | "RATE_DECISION"
  | "TREASURY_AUCTION"
  | "PRODUCT_RECALL"
  | "POLICY_ACTION"
  | "POSITIONING"
  | "OWNERSHIP_STAKE"
  | "REGULATORY_NEWS"
  | "SETTLEMENT_FAILURE"
  | "DELISTING"
  | "HALT";

/** Beat tiers. `signature` is deliberately outside normal rotation
 *  (persona.md: the casino line "fired rarely hits like a verdict"). */
export type BeatTier = "base" | "escalation" | "signature";

// ---------------------------------------------------------------------------
// Gate DSL. A closed set of operators — no escape hatch. When a beat needs
// something the DSL can't express, the FACT is derived in the archetype's
// payload normalizer (auditable in one place), never by widening the
// interpreter. Numeric ops NEVER coerce: a string that looks like a number
// evaluates false, because coercion is how an unparsed field sneaks into a
// published claim.

export type Gate =
  | { op: "has"; field: string } // field present and non-empty
  | { op: "eq"; field: string; value: string | number | boolean }
  | { op: "neq"; field: string; value: string | number | boolean }
  | { op: "gte"; field: string; value: number }
  | { op: "lte"; field: string; value: number }
  | { op: "gt"; field: string; value: number }
  | { op: "lt"; field: string; value: number }
  | { op: "includes"; field: string; value: string } // array field contains value
  | { op: "gtField"; field: string; other: string } // numeric field > numeric field
  | { op: "all"; of: readonly Gate[] }
  | { op: "any"; of: readonly Gate[] };

export const GATE_OPS = [
  "has",
  "eq",
  "neq",
  "gte",
  "lte",
  "gt",
  "lt",
  "includes",
  "gtField",
  "all",
  "any",
] as const;

// ---------------------------------------------------------------------------

export interface Beat {
  /** Stable forever: recorded on the queue row and used as the rotation key. */
  readonly id: string;
  /** Post copy. `{slot}` markers interpolate parsed values. */
  readonly text: string;
  readonly tier: BeatTier;
  /** REQUIRED. No ungated beats. */
  readonly when: Gate;
  /**
   * Numbers/codes allowed to appear literally in `text` despite not coming
   * from the payload (e.g. the SEC item code "4.02" in a beat about 4.02
   * filings). persona.md §11 bans numbers in beats that aren't in the
   * payload; this allowlist is what makes that testable.
   */
  readonly literals?: readonly string[];
}

/**
 * Beats the persona doc marks DISABLED-UNTIL-BUILT (they need a D1 lookback
 * or tape data that does not exist yet). No `when`, no `text` rendering path,
 * and a unique-symbol brand so a PendingBeat is not assignable to Beat and
 * cannot be synthesized outside its own module. Enforcement is `tsc`.
 */
declare const UNRENDERABLE: unique symbol;
export type Capability =
  | "d1_issuer_lookback"
  | "d1_symbol_lookback"
  | "tape_join"
  | "statement_diff"
  | "paper_ptr_postable";
export interface PendingBeat {
  readonly [UNRENDERABLE]: true;
  readonly id: string;
  readonly text: string;
  readonly requires: readonly Capability[];
}

/** P5 adds image posts; the shape exists now so signatures don't churn later. */
export interface MediaRef {
  readonly kind: "image";
  readonly url: string;
  readonly alt: string;
}

export interface SkeletonOutput {
  readonly lines: readonly string[];
  readonly media?: readonly MediaRef[];
}

export interface Skeleton {
  readonly id: string;
  /** Fails CLOSED: null when this variant's required fields didn't parse. */
  readonly build: (p: Payload) => SkeletonOutput | null;
}

/** Suppresses EVERY beat when false (persona §11: never a beat on an amendment). */
export interface BeatGuard {
  readonly id: string;
  readonly ok: (p: Payload) => boolean;
}

export type Payload = Record<string, unknown>;

export interface Archetype {
  readonly id: ArchetypeId;
  /** Mandatory attribution, appended to the fact block by the renderer. */
  readonly attribution: string;
  /** At least two skeletons or the rotation invariant is unsatisfiable. */
  readonly skeletons: readonly [Skeleton, Skeleton, ...Skeleton[]];
  readonly beats: readonly Beat[];
  readonly guards?: readonly BeatGuard[];
  /** Documentation only; unreachable by type. */
  readonly pending?: readonly PendingBeat[];
}
