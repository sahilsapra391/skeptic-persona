import { describe, expect, it } from "vitest";
import { FLOOR_GATES, payloadFacts } from "../src/rag/validate";
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
/**
 * A payload that licenses the exemplar's OWN FACTS, derived from the exemplar
 * rather than hand-written.
 *
 * The distinction this test needs: an exemplar quoting "$15,001 - $50,000"
 * fails numberCheck against any payload that does not carry those figures, and
 * that is a FIXTURE MISMATCH, not a defect. (I made exactly that mistake twice
 * while finding this bug — first with placeholder tickers, then with one shared
 * payload for seven exemplars.) So every number and date the exemplar states is
 * licensed here, leaving the gates to judge the LANGUAGE.
 *
 * Names are deliberately NOT licensed. If they were, entityCheck would pass
 * trivially and the test would assert nothing — which is the whole defect class
 * it exists to catch.
 */
function payloadLicensingFactsOf(text: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    member: "Jane Roe", chamber: "senate", ticker: "LMT", company: "Lockheed Martin",
  };
  let n = 0;
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    payload[`fig${n++}`] = Number(m[0].replace(/,/g, ""));
  }
  // Date phrases ("June 3", "March 4") as ISO, so dateCheck matches structurally.
  const MONTHS: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  // Spelled-out quantities too ("eleven transactions", "Nine days"). Without
  // these the test reports a DIFFERENT defect — see the derived-figure finding
  // in docs/verification/2026-08-01-exemplars-vs-floor.md — and that one is an
  // enrichment gap, not a language construction, so it does not belong here.
  const WORDS: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  };
  const TENS: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  let w = 0;
  // Hyphenated compounds first ("sixty-one"), then bare words.
  for (const m of text.matchAll(/\b([A-Za-z]+)-([A-Za-z]+)\b/g)) {
    const t = TENS[m[1]!.toLowerCase()], u = WORDS[m[2]!.toLowerCase()];
    if (t !== undefined && u !== undefined) payload[`word${w++}`] = t + u;
  }
  for (const m of text.matchAll(/\b([A-Za-z]+)\b/g)) {
    const v = WORDS[m[1]!.toLowerCase()] ?? TENS[m[1]!.toLowerCase()];
    if (v !== undefined) payload[`word${w++}`] = v;
  }
  let d = 0;
  for (const m of text.matchAll(/\b([A-Z][a-z]+)\s+(\d{1,2})\b/g)) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    if (mo) payload[`date${d++}`] = `2026-${String(mo).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return payload;
}

const COVERED_ARCHETYPES = new Set(["CONGRESS_PTR"]);

describe("owner exemplars vs the fabrication floor", () => {
  const covered = OWNER_EXEMPLARS.filter((e) => COVERED_ARCHETYPES.has(e.archetype));

  it("enumerates the gates from the PIPELINE's list, not a copy of it", () => {
    // The whole point. If someone adds a gate to the floor, this test starts
    // applying it to the exemplars automatically — which is the only version
    // that stays true. A hand-maintained second list is how the two specs
    // drifted apart in the first place.
    expect(FLOOR_GATES.length).toBeGreaterThanOrEqual(5);
    expect(FLOOR_GATES.map((g) => g.name)).toContain("entityCheck");
    expect(FLOOR_GATES.map((g) => g.name)).toContain("numberCheck");
  });

  it("has a payload shape for at least one archetype (guards a vacuous pass)", () => {
    // Without this, shrinking PAYLOAD_FOR to {} would make every assertion
    // below iterate an empty list and report green.
    expect(covered.length).toBeGreaterThan(0);
  });

  for (const [i, ex] of covered.entries()) {
    it(`E${i + 1} ${ex.archetype} survives the FLOOR: "${ex.text.slice(0, 38).replace(/\n/g, " ")}..."`, () => {
      const payload = payloadLicensingFactsOf(ex.text);
      const facts = payloadFacts(payload);
      const issues = FLOOR_GATES.flatMap((g) => g.run(ex.text, payload, facts));
      expect(issues.map((x) => `${x.rule}: ${x.detail}`)).toEqual([]);
    });
  }

  // The specific construction, pinned separately so the cause stays legible
  // after the exemplar bank changes.
  it("a sentence-initial capitalised verb before a month is not a proper name", () => {
    const payload = payloadLicensingFactsOf("Filed July 18. Disclosed July 18. Reported June 3.");
    const facts = payloadFacts(payload);
    for (const line of ["Filed July 18.", "Disclosed July 18.", "Reported June 3."]) {
      const issues = FLOOR_GATES.flatMap((g) => g.run(line, payload, facts));
      expect(issues.map((x) => x.detail), line).toEqual([]);
    }
  });

  // The opposite direction, so the fix cannot be "stop checking names".
  it("still rejects a genuinely fabricated multi-token name", () => {
    const payload = payloadLicensingFactsOf("Josh Gottheimer reported it");
    const facts = payloadFacts(payload);
    expect(FLOOR_GATES.flatMap((g) => g.run("Josh Gottheimer reported it", payload, facts)).length).toBeGreaterThan(0);
  });
});
