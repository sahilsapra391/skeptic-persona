import { describe, expect, it } from "vitest";
import { PRESS_ATTRIBUTION } from "../src/ingesters/pressAttribution";
import { PRESS_SOURCES } from "../src/ingesters/regulatoryPress";
import { ARCHETYPES } from "../src/templates";
import { renderPost, resolveAttribution } from "../src/templates/render";
import { checkRegister } from "../src/templates/validate";
import { sourcingCheck } from "../src/rag/validate";

const CFTC_PAYLOAD = {
  authority: "CFTC",
  title: "CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
  factLine: "CFTC: CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
  publishedIso: "2026-07-31T19:26:52.000Z",
};

describe("PRESS_ATTRIBUTION map (p4-00b)", () => {
  it("covers every authority a press source can write into a payload", () => {
    // Drift guard: an ingester renaming an authority string must fail HERE,
    // not silently refuse to render in production.
    for (const src of PRESS_SOURCES) {
      expect(PRESS_ATTRIBUTION[src.authority], `no attribution for "${src.authority}"`).toBeTruthy();
    }
  });

  it("resolves the named body for a press payload", () => {
    expect(resolveAttribution(ARCHETYPES.REGULATORY_NEWS, CFTC_PAYLOAD)).toBe("per CFTC");
  });

  it("renders the citation the owner's exemplars use", () => {
    const r = renderPost(ARCHETYPES.REGULATORY_NEWS, CFTC_PAYLOAD, { seed: "reg:918" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain(", per CFTC");
    expect(r.text).not.toContain("issuing authority");
  });

  it("refuses to render an unknown authority rather than guessing", () => {
    const r = renderPost(
      ARCHETYPES.REGULATORY_NEWS,
      { ...CFTC_PAYLOAD, authority: "Ministry of Truth" },
      { seed: "reg:919" },
    );
    expect(r).toEqual({ ok: false, reason: "no_attribution" });
  });

  it("register accepts ONLY this item's authority — cross-authority citation dies", () => {
    const perCftc = `${CFTC_PAYLOAD.factLine}, per CFTC.`;
    const perSec = `${CFTC_PAYLOAD.factLine}, per SEC.`;
    expect(checkRegister(perCftc, "REGULATORY_NEWS", CFTC_PAYLOAD)).toEqual([]);
    const issues = checkRegister(perSec, "REGULATORY_NEWS", CFTC_PAYLOAD);
    expect(issues.some((i) => i.rule === "attribution")).toBe(true);
  });

  it("sourcing allow-list now carries the mapped citations, and only ours", () => {
    // The exact failure of the first live generation: "per CFTC" was
    // rejected as "not one of our records".
    expect(sourcingCheck("CFTC orders a $35,000 payment, per CFTC.")).toEqual([]);
    expect(sourcingCheck("Regulators act, per the FCA.")).toEqual([]);
    // Republishing wearing our furniture still dies.
    expect(sourcingCheck("Markets fell, per Bloomberg.").some((i) => i.rule === "sourcing")).toBe(true);
  });
});
