import { describe, expect, it } from "vitest";
import {
  archetypeForItems,
  buildEarningsPayload,
  displayNameFor,
  periodLabel,
  sizeBump,
  sizeTier,
  ACCELERATED_FLOOR,
  LARGE_ACCELERATED_FLOOR,
  type IssuerRow,
} from "../src/pipeline/earnings";
import { renderPost } from "../src/templates/render";
import { ARCHETYPES } from "../src/templates/archetypes";
import { checkRegister } from "../src/templates/validate";
import { salienceFor } from "../src/salience";
import { cardImageFor } from "../src/render/forArchetype";

// p5-20, THE EARNINGS LANE. Every test here is about a refusal.

const ABBOTT: IssuerRow = { cik: 1800, name: "ABBOTT LABORATORIES", ticker: "ABT", exchange: "NYSE", public_float: 232_169_255_381 };
const NOFLOAT: IssuerRow = { cik: 999, name: "SMALL CO INC", ticker: "SMCO", exchange: "NASDAQ", public_float: null };

describe("no number ever comes out of prose", () => {
  it("the payload carries no earnings figure at all", () => {
    const p = buildEarningsPayload({
      company: "ABBOTT LABORATORIES",
      cik: "1800",
      formType: "8-K",
      filedIso: "2026-08-06T20:05:00.000Z",
      periodIso: "2026-06-30",
      issuer: ABBOTT,
    });
    // Nothing resembling EPS, revenue, guidance or a surprise. The point is
    // that no template CAN interpolate one, not that none currently does.
    for (const forbidden of ["eps", "revenue", "netIncome", "guidance", "surprise", "beat", "miss"]) {
      expect(Object.keys(p).map((k) => k.toLowerCase())).not.toContain(forbidden);
    }
    // The float rides for the ledger but has NO display field: this lane
    // never prints a company's size.
    expect(p.publicFloat).toBe(232_169_255_381);
    expect(Object.keys(p).some((k) => /float.*display|display.*float/i.test(k))).toBe(false);
  });

  it("no skeleton or beat in the archetype has a numeric slot for results", () => {
    const a = ARCHETYPES.EARNINGS_EVENT;
    const allText = [...a.beats.map((b) => b.text)].join(" ");
    // The one interpolation allowed is the lookback occurrence count, which is
    // a COUNT OF FILINGS in our own lake, not a figure from a press release.
    const slots = allText.match(/\{[a-zA-Z0-9_.]+(?::[a-z]+)?\}/g) ?? [];
    expect(slots).toEqual(["{sameItemOccurrence}"]);
  });
});

describe("a cashtag is a lookup, never a guess", () => {
  it("resolves through the issuer row, and falls back to the FILED name", () => {
    expect(displayNameFor("ABBOTT LABORATORIES", ABBOTT)).toBe("$ABT");
    // 7.3% of stored 8-K items do not resolve (measured 2026-08-06). Those
    // render the company name exactly as filed — never a guessed ticker.
    expect(displayNameFor("SOME PRIVATE ISSUER LLC", null)).toBe("SOME PRIVATE ISSUER LLC");
    expect(displayNameFor("BLANK TICKER CO", { ...ABBOTT, ticker: "  " })).toBe("BLANK TICKER CO");
  });
});

describe("size raises attention and never gates it", () => {
  it("tiers off the SEC's own filer floors, not invented numbers", () => {
    expect(LARGE_ACCELERATED_FLOOR).toBe(700_000_000);
    expect(ACCELERATED_FLOOR).toBe(75_000_000);
    expect(sizeTier(1_000_000_000)).toBe("large");
    expect(sizeTier(LARGE_ACCELERATED_FLOOR)).toBe("large");
    expect(sizeTier(100_000_000)).toBe("accelerated");
    expect(sizeTier(10_000_000)).toBe("small");
  });

  it("a MISSING float is unmeasured, not small, and costs nothing", () => {
    // Only 54.4% of issuers carry a float. Demoting the rest would suppress
    // real news from half the universe on a missing field — the "absence we
    // did not parse" the never-list forbids asserting.
    expect(sizeTier(null)).toBe("unmeasured");
    expect(sizeTier(0)).toBe("unmeasured");
    expect(sizeBump("unmeasured")).toBe(0);
    expect(sizeBump("small")).toBe(0);
    expect(sizeBump("large")).toBeGreaterThan(0);

    const withFloat = salienceFor("EARNINGS_EVENT", { sizeTier: "large" });
    const without = salienceFor("EARNINGS_EVENT", { sizeTier: "unmeasured" });
    expect(withFloat.score).toBeGreaterThan(without.score);
    // And the unmeasured case is not below the floor: it still cards.
    const small = salienceFor("EARNINGS_EVENT", { sizeTier: "small" });
    expect(without.score).toBe(small.score);
  });
});

describe("the period is stated or omitted, never inferred", () => {
  it("names a calendar quarter only when the period END is one", () => {
    expect(periodLabel("2026-06-30")).toBe("Q2 2026");
    expect(periodLabel("2026-12-31")).toBe("Q4 2026");
    // A non-standard fiscal close gets the month, not a guessed fiscal Q.
    expect(periodLabel("2026-07-31")).toBe("the period ended July 2026");
  });

  it("omits it entirely when the SEC states none", () => {
    // Inferring "Q2" from a filing date would be a claim about which quarter
    // a company reported.
    expect(periodLabel(null)).toBeNull();
    expect(periodLabel(undefined)).toBeNull();
    expect(periodLabel("not a date")).toBeNull();
    const p = buildEarningsPayload({
      company: "X CO", cik: "1", formType: "8-K", filedIso: "2026-08-06T20:05:00.000Z", periodIso: null, issuer: null,
    });
    expect(p.periodLabel).toBeUndefined();
  });
});

describe("routing", () => {
  it("2.02 is an earnings event, and 4.02 outranks it", () => {
    expect(archetypeForItems(["2.02"])).toBe("EARNINGS_EVENT");
    expect(archetypeForItems(["2.02", "9.01"])).toBe("EARNINGS_EVENT");
    // A filing that reports results AND disclaims prior financials is a
    // non-reliance story; carding it as routine earnings buries the point.
    expect(archetypeForItems(["2.02", "4.02"])).toBe("FILING_8K");
    expect(archetypeForItems(["5.02"])).toBe("FILING_8K");
    expect(archetypeForItems([])).toBe("FILING_8K");
  });
});

describe("rendering", () => {
  const payload = () =>
    buildEarningsPayload({
      company: "ABBOTT LABORATORIES",
      cik: "1800",
      formType: "8-K",
      filedIso: "2026-08-06T20:05:00.000Z",
      periodIso: "2026-06-30",
      issuer: ABBOTT,
    });

  it("renders, cites the SEC, and states no figure", () => {
    for (const seed of ["a", "b", "c"]) {
      const r = renderPost(ARCHETYPES.EARNINGS_EVENT, payload(), { seed });
      expect(r.ok, seed).toBe(true);
      if (!r.ok) continue;
      expect(r.text).toContain("$ABT");
      expect(r.text).toContain("per SEC");
      expect(checkRegister(r.text, "EARNINGS_EVENT", payload())).toEqual([]);
      // No digits beyond the date and the item number.
      expect(r.text).not.toMatch(/\$\d/);
    }
  });

  it("refuses to render without a filing timestamp", () => {
    const p: Record<string, unknown> = { ...payload() };
    delete p.filedIso;
    expect(renderPost(ARCHETYPES.EARNINGS_EVENT, p, { seed: "x" }).ok).toBe(false);
  });

  it("gets an EVENT card, not a hero-number card", async () => {
    const img = await cardImageFor("EARNINGS_EVENT", payload());
    expect(img).not.toBeNull();
    expect(img!.filename).toBe("earnings_event.png");
    const dv = new DataView(img!.png.buffer, img!.png.byteOffset, img!.png.byteLength);
    expect(dv.getUint32(16)).toBe(1200);
    // An unresolvable payload gets no card rather than a blank one.
    expect(await cardImageFor("EARNINGS_EVENT", { displayName: "$ABT" })).toBeNull();
  });

  it("an unresolved ticker still cards, under the filed name", async () => {
    const p = buildEarningsPayload({
      company: "SOME PRIVATE ISSUER LLC", cik: "42", formType: "8-K",
      filedIso: "2026-08-06T20:05:00.000Z", periodIso: null, issuer: null,
    });
    expect(p.displayName).toBe("SOME PRIVATE ISSUER LLC");
    expect(p.sizeTier).toBe("unmeasured");
    const r = renderPost(ARCHETYPES.EARNINGS_EVENT, p, { seed: "z" });
    expect(r.ok).toBe(true);
    expect(await cardImageFor("EARNINGS_EVENT", p)).not.toBeNull();
  });
});

describe("the coverage guard on occurrence claims", () => {
  it("omits the count when source coverage does not predate the window", async () => {
    // An occurrence count is a claim about a WINDOW. If we started observing
    // edgar_8k in July, "filing number 3 of this item this year" is not a
    // fact we hold: January to June are invisible and the true count may be
    // higher. OMITTED, not shrunk — the same rule as every pattern field.
    const { ARCHETYPES: A } = await import("../src/templates/archetypes");
    const { evaluateGate } = await import("../src/templates/gate");
    const beat = A.EARNINGS_EVENT.beats.find((b) => b.id === "earn.repeat")!;

    // Covered: the field is present and the beat can fire.
    expect(evaluateGate(beat.when, { sameItemOccurrence: 3, lookbackCoverageDays: 400, lookbackWindowDays: 218 })).toBe(true);
    // Not covered: the ingester omits the field entirely, so the gate cannot
    // match whatever the coverage numbers say.
    expect(evaluateGate(beat.when, { lookbackCoverageDays: 30, lookbackWindowDays: 218 })).toBe(false);
    // And the same guard protects the FILING_8K beats it was modelled on.
    const b8k = A.FILING_8K.beats.find((b) => b.id === "8k.sameItemAgain")!;
    expect(evaluateGate(b8k.when, { sameItemOccurrence: 4 })).toBe(true);
    expect(evaluateGate(b8k.when, {})).toBe(false);
  });

  it("the beat's own text cannot render without the field", async () => {
    const { fillSlots } = await import("../src/templates/render");
    const text = "Filing number {sameItemOccurrence} of this item from this issuer this year.";
    expect(fillSlots(text, { sameItemOccurrence: 3 })).toContain("number 3");
    // fillSlots returns null on a missing field, so an omitted count drops
    // the whole beat rather than rendering a hole.
    expect(fillSlots(text, {})).toBeNull();
  });
});
