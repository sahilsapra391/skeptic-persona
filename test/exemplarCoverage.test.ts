import { describe, expect, it } from "vitest";
import PAYLOADS from "./fixtures/round2-exemplar-payloads.json";
import { ARCHETYPES } from "../src/templates";
import { OWNER_EXEMPLARS, EXEMPLAR_MAX_WEIGHTED } from "../src/rag/stylepack";
import { checkRegister } from "../src/templates/validate";
import { weightedLength } from "../src/templates/length";
import { FLOOR_GATES, payloadFacts } from "../src/rag/validate";
import type { ArchetypeId } from "../src/templates/types";

/**
 * THE GUARD AGAINST A WHOLE DEFECT CLASS.
 *
 * An archetype with an empty exemplar bank does not degrade gracefully: the
 * gate refuses generation outright, every card falls back to a voiceless
 * template, and nothing anywhere says why. B-08.4 fixed four such archetypes.
 * Sweeping the registry afterwards found SIX more with zero exemplars, four of
 * which were actively carding — 53 cards had been falling back silently.
 *
 * Twice is a class. This test is the guard, so the answer is a red suite rather
 * than another archaeology session.
 */

const PAY = PAYLOADS as unknown as Record<string, Record<string, unknown>>;
const ROUND2 = ["POLICY_ACTION", "SETTLEMENT_FAILURE", "POSITIONING", "FED_PRESS"] as const;

/** Never carded, so they cost nothing today. Listed so the exemption is a
 *  decision with a name rather than an oversight. */
const NEVER_CARDED_YET = new Set(["STORM", "TREASURY_AUCTION"]);

describe("exemplar coverage: no archetype may ship with an empty bank", () => {
  it("every registered archetype has at least one exemplar", () => {
    const withExemplars = new Set(OWNER_EXEMPLARS.map((e) => e.archetype));
    const empty = Object.keys(ARCHETYPES).filter(
      (id) => !withExemplars.has(id as ArchetypeId) && !NEVER_CARDED_YET.has(id),
    );
    expect(
      empty,
      `these archetypes would refuse generation and fall back to a voiceless template: ${empty.join(", ")}`,
    ).toEqual([]);
  });

  it("the exempted ones are exempt for a stated reason, not by accident", () => {
    // If one of these starts carding, it must come off this list and get a
    // bank. The exemption is about zero traffic, not about being unimportant.
    for (const id of NEVER_CARDED_YET) expect(Object.keys(ARCHETYPES)).toContain(id);
  });
});

describe("round-2 provisionals are grounded in their real payloads", () => {
  const provisionals = OWNER_EXEMPLARS.filter(
    (e) => e.provisional && (ROUND2 as readonly string[]).includes(e.archetype),
  );

  it("covers all four carding archetypes, with a commentary register each", () => {
    for (const a of ROUND2) {
      const mine = provisionals.filter((e) => e.archetype === a);
      expect(mine.length, `${a}`).toBeGreaterThanOrEqual(2);
      expect(mine.some((e) => e.register === "commentary"), `${a} needs commentary`).toBe(true);
    }
  });

  it("survives the FULL FLOOR against the real stored payload", () => {
    for (const a of ROUND2) {
      const payload = PAY[a];
      if (!payload) continue;
      const facts = payloadFacts(payload as never);
      for (const e of provisionals.filter((x) => x.archetype === a)) {
        const issues = FLOOR_GATES.flatMap((g) => g.run(e.text, payload as never, facts));
        expect(issues, `${a}: ${issues.map((i) => `${i.rule}: ${i.detail}`).join("; ")}\n${e.text}`).toEqual([]);
      }
    }
  });

  it("passes the register guard and the 272 margin", () => {
    for (const e of provisionals) {
      const reg = checkRegister(e.text, e.archetype as ArchetypeId, PAY[e.archetype] as never);
      expect(reg, `${e.archetype}: ${reg.map((i) => i.detail).join("; ")}\n${e.text}`).toEqual([]);
      expect(weightedLength(e.text), `${e.archetype}\n${e.text}`).toBeLessThanOrEqual(EXEMPLAR_MAX_WEIGHTED);
    }
  });

  it("FED_PRESS states NO number, because its payload carries none", () => {
    // The payload is a title and a category. An exemplar reaching for a figure
    // it does not have teaches the model to invent one.
    const fed = provisionals.filter((e) => e.archetype === "FED_PRESS");
    expect(fed.length).toBeGreaterThan(0);
    for (const e of fed) expect(e.text).not.toMatch(/\d/);
  });

  it("obeys the structural law and the doctrine bans", () => {
    for (const e of provisionals) {
      const lines = e.text.split("\n").filter((l) => l.trim() !== "");
      expect(lines[0], `${e.archetype} head line needs attribution`).toMatch(/, per [A-Za-z]/);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(e.text).not.toContain("—");
      expect(e.text).not.toContain("#");
      expect(e.text).not.toContain("BREAKING");
      expect(e.text).not.toMatch(/\b(buy|sell|watch|avoid|bullish|bearish)\b/i);
    }
  });
});
