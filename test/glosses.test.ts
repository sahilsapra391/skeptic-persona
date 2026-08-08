import { describe, expect, it } from "vitest";
import { ITEM_GLOSSES, itemGloss, roleGloss } from "../src/templates/glosses";

// p6-02 / A4. Sourced from SEC's own Form 8-K (form8-k.pdf, HTTP 200,
// 1,022,559 bytes, 2026-08-08) and cross-checked against the 866 item rows in
// our lake. A gloss says what the FORM says the item is for; it never says
// what a particular filing means.
describe("item-code glosses", () => {
  it("card #1248's item reads as English", () => {
    expect(itemGloss("3.01")).toBe("got a delisting or listing-deficiency notice");
  });

  it("covers every code that actually arrives", () => {
    // The 18 codes seen across a 400-filing sample on 2026-08-08.
    for (const code of [
      "9.01", "2.02", "7.01", "8.01", "5.02", "1.01", "3.02", "5.07", "2.03",
      "5.03", "2.01", "3.01", "3.03", "1.02", "4.01", "5.01", "5.08", "4.02",
    ]) {
      expect(itemGloss(code), code).not.toBeNull();
    }
  });

  it("an UNKNOWN code returns null so the caller falls back to SEC's own title", () => {
    // Inventing a gloss for an item nobody has read is the fabrication this
    // registry exists to prevent.
    expect(itemGloss("6.66")).toBeNull();
    expect(itemGloss("")).toBeNull();
  });

  it("every entry keeps SEC's own title beside the gloss, for audit", () => {
    for (const [code, g] of Object.entries(ITEM_GLOSSES)) {
      expect(g.title.length, code).toBeGreaterThan(10);
      expect(g.gloss.length, code).toBeGreaterThan(3);
      // the gloss is a verb phrase, not a re-run of the header
      expect(g.gloss, code).not.toBe(g.title);
      expect(g.gloss[0], code).toBe(g.gloss[0]!.toLowerCase());
    }
  });
});

describe("officer-title glosses", () => {
  it("shortens the exact long forms and nothing else", () => {
    expect(roleGloss("Chief Executive Officer")).toBe("CEO");
    expect(roleGloss("chief financial officer")).toBe("CFO");
    expect(roleGloss("Chief Operating Officer")).toBe("COO");
  });

  it("prints anything else EXACTLY as filed", () => {
    // Compressing these would be the desk deciding which of a person's roles
    // matters, which the record does not say.
    for (const t of [
      "EVP, General Counsel and Secretary",
      "SVP, Global Operations",
      "President and CEO",
      "Global General Counsel",
      "Head of Energy Transition",
      "EVP of R&D and CMO",
    ]) {
      expect(roleGloss(t)).toBe(t);
    }
  });

  it("the checkbox list becomes English (owner, A4)", () => {
    expect(roleGloss("Officer, Director")).toBe("an officer and director");
    expect(roleGloss("Director, Officer")).toBe("an officer and director");
  });

  it("an absent title is null, never an invented role", () => {
    expect(roleGloss(null)).toBeNull();
    expect(roleGloss("")).toBeNull();
    expect(roleGloss("   ")).toBeNull();
  });
});
