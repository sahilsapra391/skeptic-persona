import { describe, expect, it } from "vitest";
import { aphorismCheck, definitionalClaims, payloadFacts } from "../src/rag/validate";
import { DEFINITIONS, boundDefinitionsFor } from "../src/rag/definitions";
import { OWNER_EXEMPLARS, MOVE_EXAMPLES } from "../src/rag/stylepack";
import PERSONA_DOC from "../docs/persona.md?raw";
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
 * What the aphorism rule still finds in artefacts that teach the model, AFTER
 * the owner's D-31 ruling of 2026-08-06.
 *
 * The ruling split the group in two. Provenance beats STAY, bound by the
 * `source-owned-figure` registry entry whose cash-out is the item's own
 * resolved attribution. Metaphor beats RETIRE — `form4.decision`,
 * `n144.noticeNotTrade` (persona.md:112, archetypes.ts:240) and
 * `cluster.reason` are gone from both the library and the signed doc.
 *
 * What remains is exemplar text plus ONE beat, and the beat is a genuinely
 * open classification rather than an oversight — see BEAT_CLASSIFICATION_OPEN.
 */
const KNOWN_UNBOUND_APHORISMS = [
  // Exemplar text (wire register), owner-authored, not beats.
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
] as const;

/**
 * CLOSED 2026-08-06 by the owner's ruling on "The lag is the product."
 *
 * It stays, and the cash-out rule is what keeps it: it binds to the item's own
 * parsed lag AND to the registry's 45-day/$200 PTR entry. The beat is gated to
 * match the claim it makes, so a filing disclosed inside the statutory
 * deadline never carries it. This is the worked example of a bound
 * definitional beat, and the beat library now has no unbound line left.
 */

describe("what the rule finds in artefacts that teach the model", () => {
  it("the beat library's unbound definitional lines are exactly the known list", () => {
    const found = new Set<string>();
    // A payload shaped like an item that actually carries the fields these
    // beats gate on. Scanning against {} would report every RECORD-kind
    // binding as unbound and hide what the rulings actually did.
    const licensed = { lagDays: 87, priorNonRelianceCount: 2 };
    for (const arch of Object.values(ARCHETYPES)) {
      // Resolve THIS archetype's citation, because that is the provenance
      // group's cash-out. Scanning with attribution:null would report every
      // provenance beat as unbound and hide the ruling's actual effect.
      const attribution =
        typeof arch.attribution === "string" ? arch.attribution : (Object.values(arch.attribution.map)[0] ?? null);
      for (const beat of arch.beats) {
        for (const c of definitionalClaims(beat.text)) {
          if (boundDefinitionsFor(c, { payload: licensed, numbers: new Set(), attribution }).length === 0) found.add(c);
        }
      }
    }
    // After both rulings the beat library has NO unbound definitional line
    // left: the metaphors retired, the provenance group binds to the item's
    // attribution, and the lag beat binds to its own lag past the deadline.
    expect([...found].sort()).toEqual([]);
  });

  it("the retired metaphor beats are gone from the library AND from persona.md", () => {
    const beatText = Object.values(ARCHETYPES)
      .flatMap((a) => a.beats.map((b) => b.text))
      .join("\n");
    for (const gone of [
      "An award is compensation. A P is a decision.",
      "A 144 is the intent. The Form 4 is the receipt.",
      "The cluster is the fact. The reason isn't filed.",
    ]) {
      expect(beatText, gone).not.toContain(gone);
      expect(PERSONA_DOC, `${gone} still signed in persona.md`).not.toContain(gone);
    }
    // Retiring a beat must not strip an archetype bare. FED_PRESS was
    // already beatless BEFORE this ruling (verified against main), so it is
    // named rather than fixed here — a pre-existing gap belongs in the
    // ledger, not in a sprint scoped to the owner's copy law.
    const beatless = Object.entries(ARCHETYPES).filter(([, a]) => a.beats.length === 0).map(([id]) => id);
    expect(beatless, "a retirement emptied an archetype").toEqual(["FED_PRESS"]);
  });

  it("the provenance group binds, and ONLY when the item resolves a source", () => {
    // The owner's ruling in one assertion: payload attribution is the
    // cash-out. Same sentence, same payload, different verdict.
    const claims = [
      "The stake number is the filer's own.",
      "The class is the FDA's grading, not ours.",
      "The weekly change is the CFTC's own figure.",
      "The document is the source.",
      "That is the current advisory.",
      "This is the delisting, not the notice.",
      "The code is the whole story so far.",
    ];
    for (const c of claims) {
      expect(boundDefinitionsFor(c, { payload: {}, numbers: new Set(), attribution: "per SEC" }).map((d) => d.id), c).toContain(
        "source-owned-figure",
      );
      expect(boundDefinitionsFor(c, { payload: {}, numbers: new Set(), attribution: null }), `${c} bound without a source`).toEqual([]);
    }
    // And it does not swallow an unrelated aphorism just because a source resolved.
    expect(
      boundDefinitionsFor("The filing is the announcement", { payload: {}, numbers: new Set(), attribution: "per SEC" }),
    ).toEqual([]);
  });

  it("13D/13G binds to a citable rule rather than retiring", () => {
    const d = DEFINITIONS.find((x) => x.id === "schedule-13d-13g")!;
    expect(d.kind).toBe("rule");
    expect(d.citation).toContain("240.13d-1");
    expect(d.statement).toContain("changing or influencing control");
    for (const c of ["A 13D is the activist form", "A 13G is the passive one"]) {
      expect(boundDefinitionsFor(c, { payload: {}, numbers: new Set(), attribution: null }).map((x) => x.id), c).toContain(
        "schedule-13d-13g",
      );
    }
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
    expect(v2.length, "the v2 exemplars are installed").toBe(11);
    for (const e of v2) {
      expect(check(e.text, { priorNonRelianceCount: 2 }), e.text.slice(0, 40)).toEqual([]);
    }
  });
});
