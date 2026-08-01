import { describe, expect, it } from "vitest";
import { entityCheck } from "../src/rag/validate";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";

// THE MISSING CROSS-CHECK.
//
// stylepack.test.ts runs the owner exemplars through checkRegister and
// fitsInPost. Nothing in test/ has ever run them through the FABRICATION FLOOR
// — entityCheck and numberCheck — which is the gate their imitations actually
// face. So the voice authority and the floor are two independently maintained
// specifications of the same output, and no test compares them.
//
// stylepack.test.ts states the principle itself, and then applies it to one
// gate of the two:
//
//   "The pack's examples are the model's imitation targets. An example that
//    fails the register would teach the model to fail it too."
//
// The sentence stays true with "the floor" substituted for "the register".
//
// See docs/verification/2026-08-01-exemplars-vs-floor.md.

/**
 * A payload shaped like the one each archetype actually receives, carrying the
 * entities its exemplars name. Deliberately GENEROUS: the point is to catch
 * constructions the floor rejects even when every real entity is licensed, not
 * to rediscover that a mismatched payload rejects things.
 */
const PAYLOAD_FOR: Record<string, Record<string, unknown>> = {
  CONGRESS_PTR: {
    member: "Jane Roe", chamber: "senate", ticker: "LMT", company: "Lockheed Martin",
    amountMin: 1000001, amountMax: 5000000, lagDays: 45,
    tradeDate: "2026-06-03", disclosedDate: "2026-07-18",
  },
};

describe("owner exemplars vs the fabrication floor", () => {
  const covered = OWNER_EXEMPLARS.filter((e) => PAYLOAD_FOR[e.archetype]);

  it("has a payload shape for at least one archetype (guards a vacuous pass)", () => {
    // Without this, shrinking PAYLOAD_FOR to {} would make every assertion
    // below iterate an empty list and report green.
    expect(covered.length).toBeGreaterThan(0);
  });

  for (const [i, ex] of covered.entries()) {
    it(`E${i + 1} ${ex.archetype} survives entityCheck: "${ex.text.slice(0, 38).replace(/\n/g, " ")}..."`, () => {
      const issues = entityCheck(ex.text, PAYLOAD_FOR[ex.archetype]!);
      expect(issues.map((x) => x.detail)).toEqual([]);
    });
  }

  // The specific construction, pinned separately so the cause stays legible
  // after the exemplar bank changes.
  it("a sentence-initial capitalised verb before a month is not a proper name", () => {
    const payload = PAYLOAD_FOR.CONGRESS_PTR!;
    for (const line of ["Filed July 18.", "Disclosed July 18.", "Reported June 3.", "Sold March 12."]) {
      expect(entityCheck(line, payload).map((x) => x.detail), line).toEqual([]);
    }
  });

  // The opposite direction, so the fix cannot be "stop checking names".
  it("still rejects a genuinely fabricated multi-token name", () => {
    expect(entityCheck("Josh Gottheimer reported it", PAYLOAD_FOR.CONGRESS_PTR!).length).toBeGreaterThan(0);
  });
});
