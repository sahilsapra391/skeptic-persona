import { describe, expect, it } from "vitest";
import PAYLOADS from "./fixtures/provisional-exemplar-payloads.json";
import { OWNER_EXEMPLARS, EXEMPLAR_MAX_WEIGHTED } from "../src/rag/stylepack";
import { checkRegister } from "../src/templates/validate";
import { weightedLength } from "../src/templates/length";
import { FLOOR_GATES, numberCheck, payloadFacts } from "../src/rag/validate";
import type { ArchetypeId } from "../src/templates/types";

/**
 * B-08.4: the provisional exemplars, validated against the payloads they were
 * written from.
 *
 * Four archetypes had ZERO exemplars, so the gate refused generation outright
 * and four live cards sat at `skipped_no_exemplar` with a template draft and
 * no voice — INSIDER_NOTICE #1231/#1232, DELISTING #947, OWNERSHIP_STAKE #321
 * (open five weeks), PRODUCT_RECALL #1076.
 *
 * These exemplars are written by a session, not by the owner, so they get MORE
 * scrutiny than owner text, not less: every figure in them has to trace to the
 * payload of the card named in its comment. An exemplar teaches; one carrying
 * an unsupported number teaches fabrication.
 */

type Fixture = Record<string, { queueId: number; payload: Record<string, unknown> }>;
const FIX = PAYLOADS as unknown as Fixture;
const COVERED = ["INSIDER_NOTICE", "DELISTING", "OWNERSHIP_STAKE", "PRODUCT_RECALL"] as const;

// SCOPED TO B-08.4's OWN FOUR. A later sweep found six more archetypes with
// empty banks and added a round-2 set, so a global filter here would make this
// file fail every time another archetype gets a bank. Round 2 has its own
// coverage test; this one keeps asserting what it was written to assert.
const provisionals = OWNER_EXEMPLARS.filter(
  (e) => e.provisional === true && (COVERED as readonly string[]).includes(e.archetype),
);

describe("B-08.4: provisional exemplars are grounded, not invented", () => {
  it("covers exactly the four archetypes that had none, with three each", () => {
    for (const a of COVERED) {
      const mine = provisionals.filter((e) => e.archetype === a);
      expect(mine.length, `${a} provisionals`).toBe(3);
      // The gate needs exemplars to exist at all; three is the bank floor the
      // owner-finals allowance also keys off.
      expect(OWNER_EXEMPLARS.filter((e) => e.archetype === a).length).toBeGreaterThanOrEqual(3);
    }
    expect(provisionals.length).toBe(12);
  });

  it("every provisional carries at least one non-wire register", () => {
    for (const a of COVERED) {
      const regs = new Set(provisionals.filter((e) => e.archetype === a).map((e) => e.register));
      expect(regs.has("commentary"), `${a} needs a commentary exemplar`).toBe(true);
    }
  });

  it("survives the FULL FABRICATION FLOOR against the real payload", () => {
    // Stronger than test/exemplarFloor.test.ts can be for these. That sweep
    // runs a payload DERIVED from the exemplar and deliberately withholds
    // names, so entityCheck cannot pass trivially — which means real issuer
    // names trip it as a fixture artifact (the B-01.4 entries in its
    // known-conflict list say exactly this).
    //
    // Provisionals do not need that approximation: the real payload exists,
    // because the exemplar was written from a specific live card. So they run
    // the whole floor against the genuine article, names and dates included,
    // and are exempt from the derived-payload sweep on that basis.
    for (const a of COVERED) {
      const payload = FIX[a]!.payload;
      for (const e of provisionals.filter((x) => x.archetype === a)) {
        const issues = FLOOR_GATES.flatMap((g) => g.run(e.text, payload as never, payloadFacts(payload as never)));
        const detail = issues.map((i) => `${i.rule}: ${i.detail}`).join("; ");
        expect(issues, `${a} #${FIX[a]!.queueId}: ${detail}\n${e.text}`).toEqual([]);
      }
    }
  });

  it("EVERY NUMBER traces to the real stored payload it was written from", () => {
    // The load-bearing test. An exemplar is teaching material: a figure with
    // no payload behind it teaches the model to invent one.
    for (const a of COVERED) {
      const payload = FIX[a]!.payload;
      for (const e of provisionals.filter((x) => x.archetype === a)) {
        const issues = numberCheck(e.text, payload as never);
        expect(issues, `${a} #${FIX[a]!.queueId}: ${issues.map((i) => i.detail).join("; ")}\n${e.text}`).toEqual([]);
      }
    }
  });

  it("every provisional passes the register guard for its own archetype", () => {
    for (const e of provisionals) {
      const issues = checkRegister(e.text, e.archetype as ArchetypeId, FIX[e.archetype]?.payload as never);
      expect(issues, `${e.archetype}: ${issues.map((i) => i.detail).join("; ")}\n${e.text}`).toEqual([]);
    }
  });

  it("every provisional installs at or under the 272 margin", () => {
    for (const e of provisionals) {
      const w = weightedLength(e.text);
      expect(w, `${e.archetype} at ${w} weighted:\n${e.text}`).toBeLessThanOrEqual(EXEMPLAR_MAX_WEIGHTED);
    }
  });

  it("obeys the structural law: fact block first, ONE beat, never blended", () => {
    for (const e of provisionals) {
      const lines = e.text.split("\n").filter((l) => l.trim() !== "");
      // Head fact line carries the attribution; the beat never does.
      // [A-Za-z]: "per the House Clerk" and "per the Federal Reserve" are
      // pinned forms that continue in lowercase after "per".
      expect(lines[0], `${e.archetype} head line must carry attribution`).toMatch(/, per [A-Za-z]/);
      // At most a fact block plus two trailing lines, and never a bare wall.
      expect(lines.length, `${e.archetype} line count`).toBeLessThanOrEqual(3);
      expect(lines.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("stays inside doctrine: no advice, no em-dash, no hashtag, no BREAKING", () => {
    for (const e of provisionals) {
      expect(e.text).not.toContain("—");
      expect(e.text).not.toContain("#");
      expect(e.text).not.toContain("BREAKING");
      expect(e.text).not.toMatch(/\b(buy|sell|watch|avoid|bullish|bearish)\b/i);
    }
  });

  it("is flagged PROVISIONAL in the data, so the replacement queue cannot drift", () => {
    // The digest counts these. A comment would not survive a refactor.
    for (const e of provisionals) expect(e.provisional).toBe(true);
    // And nothing owner-authored is mislabelled as provisional.
    const nonProvisional = OWNER_EXEMPLARS.filter((e) => !e.provisional);
    expect(nonProvisional.every((e) => e.provisional === undefined)).toBe(true);
  });
});
