import { describe, expect, it } from "vitest";
import PERSONA_DOC from "../docs/persona.md?raw";
import {
  ANTI_PATTERNS,
  MOVE_EXAMPLES,
  OWNER_EXEMPLARS,
  VOICE_CORE,
  stylePackFor,
} from "../src/rag/stylepack";
import { ARCHETYPES } from "../src/templates/archetypes";
import { checkRegister } from "../src/templates/validate";
import { fitsInPost } from "../src/templates/length";
import type { ArchetypeId } from "../src/templates/types";

const ALL_ARCHETYPES = Object.keys(ARCHETYPES) as ArchetypeId[];

describe("stylepack doctrine parity", () => {
  // VOICE_CORE quotes persona.md. If the doc changes, this fails and the
  // pack gets re-distilled — the doc stays the voice authority.
  const QUOTED = [
    "Claims need evidence. A filing is evidence. A vibe is not.",
    "Fact first, beat last, never blended.",
    "The reader finishes the sentence.",
    "Never impute knowledge or motive",
  ];
  for (const phrase of QUOTED) {
    it(`"${phrase.slice(0, 40)}..." is verbatim in BOTH persona.md and VOICE_CORE`, () => {
      expect(PERSONA_DOC).toContain(phrase);
      expect(VOICE_CORE).toContain(phrase);
    });
  }
});

describe("positive examples obey the doctrine they teach", () => {
  for (const ex of MOVE_EXAMPLES) {
    it(`passes the register guard: "${ex.text.slice(0, 40).replace(/\n/g, " ")}..."`, () => {
      // The pack's examples are the model's imitation targets. An example
      // that fails the register would teach the model to fail it too.
      expect(checkRegister(ex.text, ex.archetype)).toEqual([]);
      expect(fitsInPost(ex.text)).toBe(true);
    });
  }

  it("every example keeps the fact block first and any beat separated", () => {
    for (const ex of MOVE_EXAMPLES) {
      const parts = ex.text.split("\n\n");
      expect(parts.length).toBeLessThanOrEqual(2); // fact block + at most one beat
      expect(parts[0]).toMatch(/per /); // attribution rides the fact block
    }
  });
});

describe("anti-patterns are genuinely negative", () => {
  it("declared registerRule entries actually trip checkRegister", () => {
    for (const p of ANTI_PATTERNS) {
      if (!p.registerRule) continue;
      const rules = checkRegister(p.example).map((i) => i.rule);
      expect(rules, `"${p.name}" claims to trip ${p.registerRule}`).toContain(p.registerRule);
    }
  });

  it("no anti-pattern example passes as a publishable post", () => {
    // Either the register guard catches it mechanically, or it embodies a
    // pattern the guard cannot see (motive, sourcing, framing) — in which
    // case it must NOT carry an attribution, so it can never be mistaken
    // for a rendered post shape.
    for (const p of ANTI_PATTERNS) {
      const mechanical = checkRegister(p.example).length > 0;
      const postShaped = /\bper (SEC|Senate eFD|Nasdaq|BLS)\b/.test(p.example);
      expect(mechanical || !postShaped, p.name).toBe(true);
    }
  });
});

describe("stylePackFor", () => {
  it("is deterministic", () => {
    expect(stylePackFor("CONGRESS_PTR")).toBe(stylePackFor("CONGRESS_PTR"));
  });

  it("assembles for every archetype and always carries core + moves + never-list", () => {
    for (const id of ALL_ARCHETYPES) {
      const pack = stylePackFor(id);
      expect(pack).toContain("STRUCTURAL LAW");
      expect(pack).toContain("THE THREE MOVES");
      expect(pack).toContain("NEVER DO");
    }
  });

  it("congress gets the measured section; others do not", () => {
    expect(stylePackFor("CONGRESS_PTR")).toContain("CONGRESS PTR — MEASURED NOTES");
    for (const id of ALL_ARCHETYPES.filter((a) => a !== "CONGRESS_PTR")) {
      expect(stylePackFor(id), id).not.toContain("MEASURED NOTES");
    }
  });

  it("never names the studied accounts — the prompt describes moves, not handles", () => {
    // Naming the accounts in the prompt would invite the model to imitate
    // them from training data, which is exactly the verbatim-echo risk the
    // pack exists to avoid. Handles live in docs/verification/, not here.
    const everything = ALL_ARCHETYPES.map(stylePackFor).join("\n");
    for (const handle of ["unusual_whales", "Heisenberg", "spectator_index", "stockmktnewz", "amit_is_investing"]) {
      expect(everything).not.toContain(handle);
    }
  });

  it("exemplar bank is empty until the owner writes them, and the gate is documented", () => {
    // p2r-04 depends on this: an empty bank must read as "refuse generation,
    // fall back to template", never as "generate without models".
    expect(OWNER_EXEMPLARS).toEqual([]);
    expect(stylePackFor("CONGRESS_PTR")).not.toContain("OWNER EXEMPLARS");
  });
});
