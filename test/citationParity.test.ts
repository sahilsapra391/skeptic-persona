import { describe, expect, it } from "vitest";
import { RATE_ATTRIBUTION } from "../src/ingesters/rateAttribution";
import { PRESS_ATTRIBUTION } from "../src/ingesters/pressAttribution";
import { PRESS_SOURCES } from "../src/ingesters/regulatoryPress";

/**
 * Four institutions publish into BOTH lanes: a policy-rate series and a press
 * feed. Each map is closed at authoring time, which stops a citation drifting
 * WITHIN a lane -- and nothing was checking ACROSS them.
 *
 * Three of the four disagreed. The Bank of England was "per Bank of England"
 * as a rate decision and "per the Bank of England" as a press release; the
 * ECB was "per European Central Bank" and "per the ECB". Same institution,
 * same night, two citations, and both maps individually correct.
 *
 * The key is the rate map's country string and the press map's authority
 * string, so no generic comparison can find these. The table is explicit on
 * purpose: adding a source to a lane an institution already has means adding
 * a row here, and this test tells you.
 */
const DUAL_LANE: ReadonlyArray<{ institution: string; rateKey: string; pressAuthority: string }> = [
  { institution: "ECB", rateKey: "Euro area", pressAuthority: "European Central Bank" },
  { institution: "Bank of England", rateKey: "United Kingdom", pressAuthority: "Bank of England" },
  { institution: "Bank of Canada", rateKey: "Canada", pressAuthority: "Bank of Canada" },
  { institution: "Riksbank", rateKey: "Sweden", pressAuthority: "Sveriges Riksbank" },
];

describe("an institution is cited the same way in every lane", () => {
  it.each(DUAL_LANE)("$institution", ({ rateKey, pressAuthority }) => {
    const fromRate = RATE_ATTRIBUTION[rateKey];
    const fromPress = PRESS_ATTRIBUTION[pressAuthority];
    expect(fromRate, `rate key "${rateKey}"`).toBeTruthy();
    expect(fromPress, `press authority "${pressAuthority}"`).toBeTruthy();
    expect(fromPress).toBe(fromRate);
  });

  it("keeps the table honest: every dual-lane row names keys that exist", () => {
    // A stale row would pass the parity check vacuously by comparing two
    // undefineds -- guarded above by toBeTruthy, and here by the reverse
    // direction: the press authority must still be a source's authority.
    const authorities = new Set(PRESS_SOURCES.map((s) => s.authority));
    for (const row of DUAL_LANE) {
      expect(authorities.has(row.pressAuthority), row.institution).toBe(true);
    }
  });
});

describe("no institution is cited two ways anywhere in the union", () => {
  // MECHANICAL, no table to maintain. Two of the three divergences found on
  // 2026-08-01 were article-only -- "per Bank of England" against "per the
  // Bank of England", and the same for the Bank of Canada -- and that class
  // is detectable without knowing which institution is which.
  //
  // It is the class that would have shipped silently, too: the ECB pair was
  // only caught because "per European Central Bank" against "per the ECB" was
  // different enough to break a validator. An article costs nothing at the
  // gate and still puts two citations for one institution on the account.
  const ALL = [...Object.entries(RATE_ATTRIBUTION), ...Object.entries(PRESS_ATTRIBUTION)];
  const norm = (cite: string) => cite.toLowerCase().replace(/^per\s+(the\s+)?/, "").replace(/\s+/g, " ").trim();

  it("has no two citations differing only by a definite article or spacing", () => {
    const byNorm = new Map<string, Set<string>>();
    for (const [, cite] of ALL) {
      const k = norm(cite);
      if (!byNorm.has(k)) byNorm.set(k, new Set());
      byNorm.get(k)!.add(cite);
    }
    const collisions = [...byNorm.entries()]
      .filter(([, forms]) => forms.size > 1)
      .map(([k, forms]) => `${k}: ${[...forms].join(" | ")}`);
    expect(collisions).toEqual([]);
  });

  it("states plainly what this does NOT catch", () => {
    // An ABBREVIATION against a full name normalises to two different keys,
    // so "per ECB" and "per European Central Bank" would both survive the
    // check above. That was the actual ECB bug, and no normalisation finds it
    // without a synonym table -- which is a hand-maintained artifact with the
    // same staleness problem as the list below.
    //
    // Pinned as a fact rather than left as an assumption, so nobody reads the
    // mechanical check as total coverage.
    expect(norm("per ECB")).not.toBe(norm("per European Central Bank"));
    expect(norm("per the Bank of England")).toBe(norm("per Bank of England"));
  });
});

describe("the ECB citation matches the exemplar the model is told to imitate", () => {
  it('declares "per ECB", the abbreviation the owner wrote', () => {
    // The owner's RATE_DECISION exemplar reads:
    //   "ECB holds the deposit facility rate at 2.00%. Third consecutive
    //    hold, per ECB."
    // sourcingCheck accepts ONLY the declared string, so while the map said
    // "per European Central Bank" every draft imitating that exemplar died on
    // `sourcing`. This is the #66 defect in a second archetype: the exemplars
    // teach the short form and the map declared a long one.
    expect(RATE_ATTRIBUTION["Euro area"]).toBe("per ECB");
    expect(PRESS_ATTRIBUTION["European Central Bank"]).toBe("per ECB");
  });

  it("uses no definite article anywhere the owner's exemplars are the evidence", () => {
    // Owner exemplars cite "per SEC", "per CFTC", "per FTC", "per ECB" --
    // never "per the X". The rate map already followed that; the press
    // entries I added in batches 1-2 did not, which is how three of the four
    // dual-lane institutions came to disagree.
    for (const [key, cite] of Object.entries(RATE_ATTRIBUTION)) {
      if (!DUAL_LANE.some((d) => d.rateKey === key)) continue;
      expect(cite, key).not.toMatch(/^per the /);
    }
    for (const row of DUAL_LANE) {
      expect(PRESS_ATTRIBUTION[row.pressAuthority], row.institution).not.toMatch(/^per the /);
    }
  });
});

describe("India is absent on purpose", () => {
  it("has no rate key, because no rate source emits one", () => {
    // The owner's RBI exemplar is filed under RATE_DECISION and cites "per
    // MPC statement" -- which names no institution, the generic form #66
    // removed. There is no rate_rbi ingester; RBI reaches the desk through
    // press_rbi as REGULATORY_NEWS.
    //
    // Adding an India key would make the map look like it covers something it
    // does not, which is the CPSC lesson in a different file. Owner call:
    // build the rate source, or re-file the exemplar.
    expect(RATE_ATTRIBUTION["India"]).toBeUndefined();
    // RBI resolves through the press lane. Deliberately NOT pinning the exact
    // string: single-lane entries still carry a definite article ("per the
    // CFPB", "per the EBA") where the owner's exemplars use none, and that is
    // a voice question for docs/persona.md rather than a call to make inside
    // a parity fix. Only the dual-lane four are pinned above, because those
    // are broken rather than merely inconsistent.
    expect(PRESS_ATTRIBUTION["Reserve Bank of India"]).toMatch(/^per .*Reserve Bank of India$/);
  });
});
