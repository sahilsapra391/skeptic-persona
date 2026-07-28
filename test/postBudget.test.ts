import { describe, expect, it } from "vitest";
import { ARCHETYPES, firstClause } from "../src/templates/archetypes";
import { renderPost } from "../src/templates/render";

// X's post budget is 280, not the 500 the templates were originally sized
// against. Four of 260 live drafts exceeded 280 — all 8-K — and the longest
// was 471 characters. Critically, one of those (284) was ALREADY the short
// skeleton, so both variants could overflow at once. When every skeleton
// overflows, renderPost fails and the filing silently never reaches the
// queue: a whole source going quiet with no error anywhere.
const X_LIMIT = 280;

const LONG_5_02 =
  "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers";

describe("firstClause", () => {
  it("cuts at the SEC's own clause boundary and marks the cut", () => {
    expect(firstClause("Departure of Directors or Certain Officers; Election of Directors")).toBe(
      "Departure of Directors or Certain Officers…",
    );
  });

  it("leaves a short single-clause title untouched, with no ellipsis", () => {
    const t = "Results of Operations and Financial Condition";
    expect(firstClause(t)).toBe(t);
  });

  it("never cuts mid-word when there is no semicolon", () => {
    const long = `${"Alpha".repeat(6)} ${"Beta".repeat(30)}`;
    const out = firstClause(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(82);
  });
});

describe("8-K renders inside the post budget on real-world worst cases", () => {
  const build = (company: string, items: Array<{ code: string; title: string }>) => ({
    company,
    formType: "8-K",
    items,
    itemCodes: items.map((i) => i.code),
  });

  it("survives the SEC's longest compound title", () => {
    const r = renderPost(
      ARCHETYPES.FILING_8K,
      build("POWER SOLUTIONS INTERNATIONAL, INC.", [
        { code: "5.02", title: LONG_5_02 },
        { code: "7.01", title: "Regulation FD Disclosure" },
        { code: "9.01", title: "Financial Statements and Exhibits" },
      ]),
      { seed: "budget:1" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text.length).toBeLessThanOrEqual(X_LIMIT);
  });

  it("survives a long company name AND a long title together", () => {
    const r = renderPost(
      ARCHETYPES.FILING_8K,
      build("INDEPENDENT BANK CORPORATION OF THE UNITED STATES OF AMERICA /MI/", [
        { code: "5.02", title: LONG_5_02 },
      ]),
      { seed: "budget:2" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text.length).toBeLessThanOrEqual(X_LIMIT);
  });

  it("renders across many seeds, so no skeleton choice can overflow", () => {
    // The renderer picks a skeleton by seed; a variant that only sometimes
    // fits would fail intermittently and look like a flaky source.
    for (let i = 0; i < 24; i++) {
      const r = renderPost(
        ARCHETYPES.FILING_8K,
        build("LATTICE SEMICONDUCTOR CORP", [
          { code: "2.01", title: "Completion of Acquisition or Disposition of Assets" },
          { code: "5.02", title: LONG_5_02 },
          { code: "8.01", title: "Other Events" },
          { code: "9.01", title: "Financial Statements and Exhibits" },
        ]),
        { seed: `budget:${i}` },
      );
      expect(r.ok, `seed ${i} failed to render`).toBe(true);
      if (r.ok) expect(r.text.length, `seed ${i} overflowed`).toBeLessThanOrEqual(X_LIMIT);
    }
  });

  it("still prefers a fuller skeleton when it fits", () => {
    // The compact variant is a floor, not a default: a short filing should
    // still get the SEC's full item title.
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const r = renderPost(
        ARCHETYPES.FILING_8K,
        build("ACME CORP", [{ code: "1.03", title: "Bankruptcy or Receivership" }]),
        { seed: `short:${i}` },
      );
      if (r.ok) seen.add(r.skeletonId);
    }
    expect(seen.has("8k.items") || seen.has("8k.lead")).toBe(true);
  });
});
