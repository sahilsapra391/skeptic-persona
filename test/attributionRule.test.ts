import { describe, expect, it } from "vitest";
import { attributionVerdict, checkRegister } from "../src/templates/validate";
import { structuralCheck } from "../src/rag/validate";
import { renderPost } from "../src/templates/render";
import { ARCHETYPES } from "../src/templates/archetypes";
import {
  ALL_ATTRIBUTION_FORMS,
  ATTRIBUTION_ENTRIES,
  acceptedForms,
  actorsFor,
  namesSourceAsActor,
} from "../src/templates/attribution";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";
import type { ArchetypeId } from "../src/templates/types";

// THE ATTRIBUTION RULE AMENDMENT (owner ruling 2026-08-06).
//
//   "Attribution is satisfied when the publishing source is the named actor
//    of the fact line ('The FTC sued...', 'A company told the SEC...'); a
//    trailing 'per X' is required only when source and actor differ."
//
// The owner asked for kill-tests in BOTH directions, and this file is them:
// actor-source redundancy is flagged, and a fact line with neither embedded
// nor trailing attribution still dies.

describe("the pinned table, and its aliases", () => {
  it("every archetype pin is registered in the attribution table", () => {
    // A pin outside the table degrades silently to itself: no aliases, no
    // actors, so the embedded form stops working for that source and nobody
    // finds out. Enumerated from ARCHETYPES so a new archetype cannot skip it.
    const pins = Object.values(ARCHETYPES).flatMap((a): string[] => {
      const attr: unknown = a.attribution;
      return typeof attr === "string" ? [attr] : Object.values((attr as { map: Record<string, string> }).map);
    });
    for (const pin of [...new Set(pins)]) {
      expect(ALL_ATTRIBUTION_FORMS, `${pin} is not in the attribution table`).toContain(pin);
    }
  });

  it("the jargon pins the owner ruled on are pinned plain, with the old strings as aliases", () => {
    expect(acceptedForms("per Senate financial disclosures")).toEqual([
      "per Senate financial disclosures",
      "per Senate eFD",
    ]);
    expect(acceptedForms("per the House Clerk")).toEqual(["per the House Clerk", "per House Clerk"]);
    // The renderer emits the PIN, never the alias.
    const senate = renderPost(ARCHETYPES.CONGRESS_PTR, { chamber: "senate", factLine: "Senator sold notes" }, { seed: "a" });
    expect(senate.ok && senate.text).toContain("per Senate financial disclosures");
    expect(senate.ok && senate.text).not.toContain("eFD");
  });

  it("aliases widen the SPELLING of the right source, never WHICH source", () => {
    // The regression that produced this rule in the first place: a House
    // filing published citing a system it never touched.
    const house = { chamber: "house" };
    for (const wrong of ["per Senate eFD", "per Senate financial disclosures"]) {
      const issues = checkRegister(`House PTR: Member sold $1,001 - $15,000, ${wrong}`, "CONGRESS_PTR", house);
      expect(issues.map((i) => i.rule), wrong).toContain("attribution");
    }
    for (const right of ["per House Clerk", "per the House Clerk"]) {
      expect(checkRegister(`House PTR: Member sold $1,001 - $15,000, ${right}`, "CONGRESS_PTR", house), right).toEqual([]);
    }
  });

  it("a disclosure system is never an actor", () => {
    // If bare "Senate" counted as embedded attribution, every draft opening
    // "Senate PTR:" would cite itself and the requirement would evaporate.
    expect(actorsFor("per Senate financial disclosures")).toEqual([]);
    expect(actorsFor("per the House Clerk")).toEqual([]);
    const issues = checkRegister("Senate PTR: purchase of $100,001 - $250,000, filed today.", "CONGRESS_PTR", {
      chamber: "senate",
    });
    expect(issues.map((i) => i.rule)).toContain("attribution");
  });
});

describe("embedded attribution", () => {
  const cases: Array<[string, ArchetypeId, Record<string, unknown>]> = [
    ["The FTC just sued to block a merger announced eleven months ago.", "REGULATORY_NEWS", { authority: "FTC" }],
    [
      "A company just told the SEC that three quarters of its own financial statements can no longer be relied on.",
      "FILING_8K",
      {},
    ],
  ];
  for (const [text, archetype, payload] of cases) {
    it(`satisfies the register: "${text.slice(0, 40)}..."`, () => {
      expect(checkRegister(text, archetype, payload)).toEqual([]);
      // structuralCheck asked the same question with its own regex and has
      // to give the same answer, or a variant passes one gate and fails the
      // next for the same sentence.
      expect(structuralCheck(text, "commentary", { archetype, payload })).toEqual([]);
    });
  }

  it("a fact line with NEITHER embedded nor trailing attribution still rejects", () => {
    const text = "A merger announced eleven months ago was blocked in court today.";
    expect(checkRegister(text, "REGULATORY_NEWS", { authority: "FTC" }).map((i) => i.rule)).toContain("attribution");
    expect(structuralCheck(text, "commentary", { archetype: "REGULATORY_NEWS", payload: { authority: "FTC" } })).not.toEqual([]);
  });

  it("embedded attribution never excuses a citation to a DIFFERENT source", () => {
    // The hole the first cut of this amendment opened, caught by the CFTC
    // cross-authority kill-test: the fact line names CFTC as its own actor,
    // so attribution was satisfied and "per SEC" rode along unchecked.
    const issues = checkRegister("CFTC orders a $35,000 payment, per SEC.", "REGULATORY_NEWS", { authority: "CFTC" });
    expect(issues.map((i) => i.rule)).toContain("attribution");
    expect(issues[0]?.detail).toContain("per SEC");
  });

  it("longest-match: a Form 4 citation is not misread as a bare 'per SEC'", () => {
    // "per SEC" is a prefix of "per SEC Form 4". A substring test reports the
    // correct citation as ALSO naming a source the draft never cited.
    const v = attributionVerdict("Form 4: director bought 40,000 shares, per SEC Form 4.", "FILING_FORM4");
    expect(v.trailing).toEqual(["per SEC Form 4"]);
    expect(v.foreign).toEqual([]);
  });
});

describe("actor-source redundancy", () => {
  it('flags "FTC sued, per FTC" — the owner\'s own example', () => {
    const issues = checkRegister("FTC sued to block a merger announced eleven months ago, per FTC.", "REGULATORY_NEWS", {
      authority: "FTC",
    });
    expect(issues.map((i) => i.rule)).toEqual(["attribution_redundant"]);
  });

  it("the same sentence without the trailing phrase is clean", () => {
    expect(
      checkRegister("The FTC just sued to block a merger announced eleven months ago.", "REGULATORY_NEWS", {
        authority: "FTC",
      }),
    ).toEqual([]);
  });

  it("a title-case headline is NOT redundancy (D-15 is a rendering defect, not a copy-law one)", () => {
    // "SEC: SEC Charges Two Individuals" states the source twice, and hard-
    // failing that shape would have refused live press drafts wholesale. The
    // verb-must-be-lowercase rule is what keeps the two apart.
    const text = "SEC: SEC Charges Two Individuals With Fraud, per SEC";
    expect(checkRegister(text, "REGULATORY_NEWS", { authority: "SEC" })).toEqual([]);
  });

  it("the source named inside a quoted REASON is not the actor of the fact", () => {
    // Live FDA recall #982: "Modern Warrior Life, LLC is recalling product.
    // Class I, reason: FDA analysis revealed..." — the firm acts, the FDA
    // does not, and dropping "per FDA" there loses a citation the post needs.
    const text =
      "Modern Warrior Life, LLC is recalling product. Class I, reason: FDA analysis revealed the presence of unapproved ingredients, per FDA";
    expect(checkRegister(text, "PRODUCT_RECALL", {})).toEqual([]);
    expect(namesSourceAsActor(text, "per FDA")).toBe(false);
  });
});

describe("the renderer stops emitting the redundancy it now flags", () => {
  it("omits the trailing citation when the head line already names the source as doer", () => {
    // Verbatim from live queue #1140.
    const r = renderPost(
      ARCHETYPES.REGULATORY_NEWS,
      {
        authority: "Reserve Bank of India",
        title: "RBI releases the results of Forward Looking Surveys",
        factLine: "Reserve Bank of India: RBI releases the results of Forward Looking Surveys",
      },
      { seed: "reg:1140" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain("per the Reserve Bank of India");
    expect(r.text).toContain("RBI releases");
    expect(checkRegister(r.text, "REGULATORY_NEWS", { authority: "Reserve Bank of India" })).toEqual([]);
  });

  it("still appends the citation when the source is NOT the actor", () => {
    const r = renderPost(
      ARCHETYPES.CONGRESS_PTR,
      { chamber: "house", factLine: "Member sold $1,001 - $15,000 of notes" },
      { seed: "h" },
    );
    expect(r.ok && r.text).toContain("per the House Clerk");
  });
});

/**
 * Owner-authored WIRE exemplars written before the amendment existed, each
 * naming its source as both actor and citation. They are the owner's text
 * and his to rewrite, not mine — and his own v2 [7] is precisely the fixed
 * form of the first pattern ("The FTC just sued...", no trailing phrase).
 *
 * Listed rather than exempted so a FOURTH cannot appear silently. Open with
 * the owner as D-32.
 */
const KNOWN_REDUNDANT_EXEMPLARS = [
  "SEC instituted administrative proceedings",
  "CFTC filed a complaint alleging manipulation",
  "ECB holds the deposit facility rate",
] as const;

describe("the exemplar bank obeys the amended rule", () => {
  it("no NEW entry carries both forms of attribution", () => {
    const found: string[] = [];
    for (const e of OWNER_EXEMPLARS) {
      if (!checkRegister(e.text, e.archetype).some((i) => i.rule === "attribution_redundant")) continue;
      found.push(e.text.slice(0, 44).replace(/\n/g, " "));
    }
    const unexpected = found.filter((f) => !KNOWN_REDUNDANT_EXEMPLARS.some((k) => f.startsWith(k)));
    expect(unexpected, "new redundant exemplar — fix it or get a ruling").toEqual([]);
    // And the list may not rot the other way: an entry the owner has since
    // rewritten must be removed from it rather than standing as an excuse.
    expect(found.length, "KNOWN_REDUNDANT_EXEMPLARS has gone stale").toBe(KNOWN_REDUNDANT_EXEMPLARS.length);
  });

  it("the table has no entry whose display is also one of its own aliases", () => {
    for (const e of ATTRIBUTION_ENTRIES) {
      expect(e.aliases, e.display).not.toContain(e.display);
    }
  });
});
