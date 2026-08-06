import { describe, expect, it } from "vitest";
import { aphorismCheck, definitionalClaims, payloadFacts } from "../src/rag/validate";
import { DEFINITIONS, boundDefinitionsFor } from "../src/rag/definitions";
import { OWNER_EXEMPLARS, MOVE_EXAMPLES } from "../src/rag/stylepack";
import { ARCHETYPES } from "../src/templates/archetypes";
import type { Payload } from "../src/templates/types";

// THE APHORISM RULE (owner ruling 2026-08-06).
//
//   "The definitional form is judged by cash-out, not grammar. A line in that
//    shape passes when its claim is backed by payload fields or the
//    definitions registry. It flags when it cashes out to nothing checkable."
//
// The owner named the test cases himself: the retired v1 lines "the filing is
// the announcement" and "a 144 is the intent" are negative; v2 [5] and [6]
// are positive.

const check = (text: string, payload: Payload = {}) => aphorismCheck(text, payload, payloadFacts(payload));

describe("the claim extractor", () => {
  it("reads BOTH sentences when two definitional lines sit back to back", () => {
    // The first cut consumed the sentence terminator as its left boundary, so
    // only the first claim of a pair was ever extracted — and the pair is the
    // exact shape this rule exists to judge ("One is a mistake. Two is a
    // pattern.").
    expect(definitionalClaims("A grant is a paycheck. A P is a decision.")).toEqual([
      "A grant is a paycheck",
      "A P is a decision",
    ]);
  });

  it("reads the X-not-Y antithesis form", () => {
    expect(definitionalClaims("This isn't an enforcement regime, it's a subscription fee for opacity.")).toContain(
      "not an enforcement regime, but a subscription fee for opacity",
    );
  });

  it("leaves ordinary statements of fact alone", () => {
    for (const plain of [
      "The order is public.",
      "Nonfarm payrolls +142,000 in June, per BLS.",
      "Filed after the bell on a Friday.",
      "Four years of collecting stock grants without reaching for the checkbook.",
    ]) {
      expect(definitionalClaims(plain), plain).toEqual([]);
    }
  });
});

describe("the owner's named negative cases", () => {
  for (const text of ["The filing is the announcement.", "A 144 is the intent."]) {
    it(`flags "${text}"`, () => {
      const issues = check(text);
      expect(issues.map((i) => i.rule)).toEqual(["aphorism"]);
      expect(issues[0]!.detail).toContain("nothing checkable");
    });
  }

  it("stays flagged even when the payload is rich — a number nearby is not a backing", () => {
    // "A 144 is the intent" against a real Form 144 payload. The form number
    // is in the payload; the claim about INTENT is not, and intent is not a
    // field any ingester parses.
    expect(check("A 144 is the intent.", { form: "144", shares: 200_000, issuer: "Example Corp" })).toHaveLength(1);
  });
});

describe("the owner's named positive cases", () => {
  it("v2 [5]: rule-backed by the insider-communication registry entry", () => {
    expect(check("The buy is the only statement insiders are allowed to make.")).toEqual([]);
  });

  it("v2 [6]: record-backed, and ONLY when the record carries the count", () => {
    const text = "One is a mistake. Two is a pattern.";
    // With the count parsed, both halves bind.
    expect(check(text, { priorNonRelianceCount: 2 })).toEqual([]);
    // Without it, the claim cashes out to nothing and the rule bites. This is
    // the whole point of the record/rule split: a statute is true whatever we
    // parsed, a count is not.
    expect(check(text, {})).toHaveLength(2);
    expect(check(text, { priorNonRelianceCount: 1 })).toHaveLength(2);
  });
});

describe("the definitions registry", () => {
  it("every entry carries a citation and a verification date", () => {
    expect(DEFINITIONS.length).toBeGreaterThanOrEqual(7);
    for (const d of DEFINITIONS) {
      expect(d.citation.length, d.id).toBeGreaterThan(20);
      expect(d.verifiedAt, d.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.invokes.length, d.id).toBeGreaterThan(0);
    }
  });

  it("record entries declare their payload requirement; rule entries do not need one", () => {
    for (const d of DEFINITIONS) {
      if (d.kind === "record") expect(d.requires, d.id).toBeTypeOf("function");
    }
  });

  it("ids are unique", () => {
    expect(new Set(DEFINITIONS.map((d) => d.id)).size).toBe(DEFINITIONS.length);
  });

  it("a rule entry binds without any payload at all", () => {
    const bound = boundDefinitionsFor("filed under Item 4.02", { payload: {}, numbers: new Set() });
    expect(bound.map((d) => d.id)).toContain("form8k-item-402");
  });

  it("the PTR entry states the figures the exemplars quote", () => {
    const ptr = DEFINITIONS.find((d) => d.id === "ptr-deadline")!;
    expect(ptr.statement).toContain("45 days");
    expect(ptr.statement).toContain("$200");
    expect(ptr.citation).toContain("13106");
  });

  it("the Reg SHO entry does NOT claim a five-day close-out", () => {
    // The five days define a THRESHOLD SECURITY; close-out runs on thirteen
    // consecutive settlement days. An entry saying otherwise would be a
    // fabricated rule wearing a citation, which is worse than no entry.
    const sho = DEFINITIONS.find((d) => d.id === "reg-sho-threshold-security")!;
    expect(sho.statement).toContain("five consecutive settlement days");
    expect(sho.statement).toContain("thirteen consecutive settlement days");
    expect(sho.statement).toContain("not a close-out deadline");
  });
});

/**
 * The beat library and exemplar bank predate this rule and carry definitional
 * lines the registry does not cover. They are OWNER-SIGNED text (persona.md
 * is the voice authority) so they are not mine to rewrite — but the gap is
 * pinned here rather than hidden, because "the pack teaches what the floor
 * rejects" is a defect this repo has already paid for once.
 *
 * Open with the owner as D-31. Note the first entry: "A 144 is the intent" is
 * one of the two lines the owner named as RETIRED, and it is live.
 */
const KNOWN_UNBOUND_APHORISMS = [
  "A 144 is the intent",
  "The Form 4 is the receipt",
  "A grant is a paycheck",
  "A P is a decision",
  "The cluster is the fact",
  "The item number is the confession",
  "The scheduled sales are the ones you can see coming",
  "A hold is a decision made by people who seriously considered mov",
  "One is a mistake",
  "Two is a method",
  "not an enforcement regime, but a subscription fee for opacity",
  "This isn't an enforcement regime, it's a subscription fee for op",
  "The code is the whole story so far",
  // PROVENANCE STATEMENTS: "this figure is the agency's, not ours". These
  // arguably DO cash out — to the payload's own attribution — and a registry
  // entry would bind them. Writing that entry is a voice call on signed
  // persona.md text, so it goes to the owner with the rest of D-31 rather
  // than being decided here.
  "The stake number is the filer's own",
  "The class is the FDA's grading, not ours",
  "The document is the source",
  "The weekly change is the CFTC's own figure",
  "The lag is the product",
  "A 13D is the activist form",
  "A 13G is the passive one",
  "This is the delisting, not the notice",
  "That is the current advisory",
] as const;

describe("what the rule finds in artefacts that teach the model", () => {
  it("the beat library's unbound definitional lines are exactly the known list", () => {
    const found = new Set<string>();
    for (const arch of Object.values(ARCHETYPES)) {
      for (const beat of arch.beats) {
        for (const c of definitionalClaims(beat.text)) {
          if (boundDefinitionsFor(c, { payload: {}, numbers: new Set() }).length === 0) found.add(c);
        }
      }
    }
    const unexpected = [...found].filter((f) => !KNOWN_UNBOUND_APHORISMS.some((k) => f.startsWith(k)));
    expect(unexpected, "a new unbound aphorism entered the beat library").toEqual([]);
    // "A 144 is the intent." is the owner's own retired-line example and it
    // is signed in persona.md line 112. If this stops finding it, the beat
    // was retired for real and D-31 can close.
    expect([...found], "D-31: the owner's named negative case is live").toContain("A 144 is the intent");
  });

  it("no exemplar or move example introduces an unbound aphorism outside the known list", () => {
    const found = new Set<string>();
    for (const t of [...OWNER_EXEMPLARS.map((e) => e.text), ...MOVE_EXAMPLES.map((e) => e.text)]) {
      // Exemplars are SYNTHETIC, so a record-kind claim has no real payload
      // behind it. Licensing a repeat count here is the fixture doing its
      // job; without it "Two is a pattern" reads as a defect in the owner's
      // text rather than an absent field in a made-up payload.
      for (const i of check(t, { priorCount: 2 })) found.add(/"([^"]+)"/.exec(i.detail)?.[1] ?? i.detail);
    }
    const unexpected = [...found].filter((f) => !KNOWN_UNBOUND_APHORISMS.some((k) => f.startsWith(k)));
    expect(unexpected, "a new unbound aphorism entered the pack").toEqual([]);
  });

  it("the v2 exemplars the owner just sent introduce NONE", () => {
    // [5] and [6] are the two v2 texts carrying definitional lines, and both
    // bind — [5] to Regulation FD, [6] to the record count.
    const v2 = OWNER_EXEMPLARS.filter((e) => e.v2);
    expect(v2.length, "the v2 commentary exemplars are installed").toBe(4);
    for (const e of v2) {
      expect(check(e.text, { priorNonRelianceCount: 2 }), e.text.slice(0, 40)).toEqual([]);
    }
  });
});
