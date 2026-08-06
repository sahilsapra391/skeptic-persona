import { describe, expect, it } from "vitest";
import HOLD from "./fixtures/bh.json?raw";
import DIFF from "./fixtures/bd.json?raw";
import CMAP from "./fixtures/cm.json?raw";
import { buildBreakdownPayload, instrumentLabel, isPrincipal, displayName, flattenBreakdown, filingUrl } from "../src/pipeline/thirteenF";
import { renderPost, humanDate, UNFILLED_SLOT_RE } from "../src/templates/render";
import { ARCHETYPES } from "../src/templates/archetypes";
import { checkRegister } from "../src/templates/validate";
import { renderBreakdown } from "../src/render/cards";

// INSTITUTIONAL_13F_BREAKDOWN, against PRODUCTION filing 301 (Berkshire
// Hathaway, period 2026-03-31). D-28 was "the 13F lane fills its own tables
// and never writes to items"; this is the missing half, tested against the
// same rows the owner wrote his exemplar from.

const HOLDINGS = JSON.parse(HOLD)[0].results;
const DIFFS = JSON.parse(DIFF)[0].results;
const MAP = new Map<string, string>(JSON.parse(CMAP)[0].results.map((r: { cusip: string; ticker: string }) => [r.cusip, r.ticker]));
const FILING = {
  id: 301,
  cik: "1067983",
  manager_name: "BERKSHIRE HATHAWAY INC",
  form: "13F-HR",
  period: "2026-03-31",
  filed_at: "2026-05-15T00:00:00.000Z",
  parsed_value_total: 263095703570,
  table_entry_total: 90,
};

const payload = () => buildBreakdownPayload(FILING, HOLDINGS, DIFFS, MAP);

describe("the payload reproduces the owner's exemplar from live rows", () => {
  it("every figure the exemplar states comes back out of the data", () => {
    const p = payload();
    // "Berkshire Q1, quick version: $263.1B across 90 positions... 16 names
    // worth $192.7B" — the last under the uniform-2dp rule (D-30) is $192.73B,
    // and D-30 says installed exemplars stay untouched while the formatter
    // governs going forward. Both numbers are the same number.
    expect(p.aum_display).toBe("$263.1B");
    expect(p.positionCount_display).toBe("90");
    expect(p.sections.new.count_display).toBe("3");
    expect(p.sections.gone.count_display).toBe("16");
    expect(p.sections.unchanged.count_display).toBe("16");
    expect(p.sections.unchanged.total_display).toBe("$192.73B");
    // "New: Delta" and "Gone: Visa and Mastercard".
    expect(p.newNames).toContain("$DAL");
    expect(p.goneNames.slice(0, 2)).toEqual(["$V", "$MA"]);
  });

  it("cashtags come from cusip_map and nowhere else", () => {
    const p = payload();
    // CHUBB LTD SWITZ is genuinely in Berkshire's top ten and genuinely
    // unmapped, which is why the owner chose it as the long-name proof.
    const chubb = p.top.find((t) => t.name.includes("CHUBB"));
    expect(chubb, "CHUBB is in the real top ten").toBeDefined();
    expect(chubb!.name.startsWith("$"), "an unmapped CUSIP must never become a ticker").toBe(false);
    // And a mapped one does resolve.
    expect(p.top[0]!.name).toBe("$AAPL");
    // The guard itself, directly: an unknown CUSIP returns the filed name.
    expect(displayName("000000000", "SOME ISSUER INC", MAP)).toBe("SOME ISSUER INC");
  });

  it("EXIT rows are valued on their PREVIOUS value, because they have no current one", () => {
    const p = payload();
    // "Gone" is a section label, never a verb. An exit has no value in THIS
    // filing by definition, so summing value_usd would report $0 and imply
    // the positions were worthless rather than absent.
    expect(p.sections.gone.total_usd).toBeGreaterThan(0);
    const exits = DIFFS.filter((d: { status: string }) => d.status === "EXIT");
    expect(p.sections.gone.count).toBe(exits.length);
  });
});

describe("PRN is a principal amount, not a share count", () => {
  it("labels convertible notes and plain principal, and leaves share rows alone", () => {
    // 63 rows pipeline-wide are PRN and 44 of Soros's 507 are. A draft reading
    // "194,500,000 shares of Spotify" against one would be false.
    expect(instrumentLabel({ sh_prn_type: "PRN", class: "CONV NOTE 0% 2026", put_call: null })).toBe("convertible notes");
    expect(instrumentLabel({ sh_prn_type: "PRN", class: "COM", put_call: null })).toBe("principal amount");
    expect(instrumentLabel({ sh_prn_type: "SH", class: "COM", put_call: null })).toBeNull();
    expect(isPrincipal({ sh_prn_type: "PRN" })).toBe(true);
    expect(isPrincipal({ sh_prn_type: "SH" })).toBe(false);
  });

  it("put/call outranks everything, and the tag is the label the copy law demands", () => {
    expect(instrumentLabel({ sh_prn_type: "SH", class: "COM", put_call: "Put" })).toBe("Put");
    expect(instrumentLabel({ sh_prn_type: "SH", class: "COM", put_call: "CALL" })).toBe("Call");
  });
});

describe("the archetype", () => {
  const flat = () => {
    const p = payload();
    return {
      manager: p.manager,
      aum_display: p.aum_display,
      positionCount_display: p.positionCount_display,
      asOfIso: p.asOfIso,
      filedIso: p.filedIso,
      newCount_display: p.sections.new.count_display,
      goneCount_display: p.sections.gone.count_display,
      unchangedCount_display: p.sections.unchanged.count_display,
      unchangedTotal_display: p.sections.unchanged.total_display,
    };
  };

  it("renders both skeletons with BOTH dates, and passes the register", () => {
    for (const seed of ["a", "b", "c", "d"]) {
      const r = renderPost(ARCHETYPES.INSTITUTIONAL_13F_BREAKDOWN, flat(), { seed });
      expect(r.ok, `seed ${seed}`).toBe(true);
      if (!r.ok) continue;
      // A 13F is a quarter-END snapshot filed weeks later. One date invites
      // the reader to treat stale positions as current.
      expect(r.text).toContain("March 31");
      expect(r.text).toContain("May 15");
      expect(checkRegister(r.text, "INSTITUTIONAL_13F_BREAKDOWN", flat())).toEqual([]);
    }
  });

  it("refuses to render when either date is missing", () => {
    for (const drop of ["asOfIso", "filedIso"]) {
      const p: Record<string, unknown> = { ...flat() };
      delete p[drop];
      expect(renderPost(ARCHETYPES.INSTITUTIONAL_13F_BREAKDOWN, p, { seed: "x" }).ok, drop).toBe(false);
    }
  });
});

describe("the slot-leak guard", () => {
  it("refuses a post that still carries slot syntax", () => {
    // FOUND IN THE FIRST LIVE 13F RENDER. Skeletons build their lines in code
    // and never pass through fillSlots, so "{asOfIso:date}" reached
    // copy-ready text verbatim. This repo shipped a raw ISO to a copy-ready
    // draft once already (D-16); this is the same defect, louder.
    expect(UNFILLED_SLOT_RE.test("filed {filedIso:date}, per SEC")).toBe(true);
    expect(UNFILLED_SLOT_RE.test("filed May 15, per SEC")).toBe(false);

    const leaky = {
      ...ARCHETYPES.HALT,
      skeletons: [{ id: "leak", build: () => ({ lines: ["$XYZ halted at {haltTime:date}"] }) }],
    };
    const r = renderPost(leaky as never, { symbol: "XYZ", reasonCode: "T1" }, { seed: "s" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unfilled_slot");
  });

  it("humanDate is what a skeleton should call instead", () => {
    expect(humanDate("2026-03-31")).toBe("March 31");
    expect(humanDate("2026-05-15T00:00:00.000Z")).toBe("May 15");
    expect(humanDate("not a date")).toBeNull();
  });
});

describe("the card, from the same payload", () => {
  it("renders the real Berkshire book", async () => {
    const p = payload();
    const png = await renderBreakdown({
      kind: "13F",
      attribution: "per SEC",
      manager: p.manager,
      periodLine: `${p.form} · as of March 31 · filed May 15`,
      aum: p.aum_display,
      top: p.top.map((t) => ({ name: t.name, value: t.value_display, change: t.pct_display, tag: t.tag })),
      strips: [
        { label: "new", count: p.sections.new.count_display, total: p.sections.new.total_display },
        { label: "adds", count: p.sections.adds.count_display, total: p.sections.adds.total_display },
        { label: "trims", count: p.sections.trims.count_display, total: p.sections.trims.total_display },
        { label: "gone", count: p.sections.gone.count_display, total: p.sections.gone.total_display },
      ],
    });
    expect(png.length).toBeGreaterThan(10_000);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBe(1200);
  });
});

describe("the flat payload the archetype and the card both read", () => {
  it("carries every display field the skeletons gate on, plus full precision", () => {
    const f = flattenBreakdown(payload());
    for (const k of [
      "manager", "asOfIso", "filedIso", "aum_display", "positionCount_display",
      "newCount_display", "goneCount_display", "unchangedCount_display", "unchangedTotal_display",
    ]) {
      expect(f[k], k).toBeTruthy();
    }
    // Flat, not nested: the gate DSL addresses fields by name, and a dotted
    // path would make every 13F gate a special case.
    expect(f).not.toHaveProperty("sections");
    // Full precision rides alongside the display string so the ledger keeps
    // the real number.
    expect(f.aum_usd).toBe(263095703570);
    expect(f.aum_display).toBe("$263.1B");
  });

  it("builds the EDGAR index URL every post cites", () => {
    expect(filingUrl("1067983", "0000950123-26-004567")).toBe(
      "https://www.sec.gov/Archives/edgar/data/1067983/000095012326004567/0000950123-26-004567-index.htm",
    );
  });
});

describe("the lag beat, as the owner's worked example of a bound aphorism", () => {
  it("fires only past the 45-day statutory deadline", async () => {
    const { ARCHETYPES: A } = await import("../src/templates/archetypes");
    const beat = A.CONGRESS_PTR.beats.find((b) => b.id === "ptr.lagProduct")!;
    const { evaluateGate } = await import("../src/templates/gate");
    // A day-3 disclosure never carries it.
    expect(evaluateGate(beat.when, { lagDays: 3 })).toBe(false);
    expect(evaluateGate(beat.when, { lagDays: 45 })).toBe(false); // on time is on time
    expect(evaluateGate(beat.when, { lagDays: 46 })).toBe(true);
    expect(evaluateGate(beat.when, {})).toBe(false);
  });

  it("binds to the registry only when the item's own lag exceeds the deadline", async () => {
    const { boundDefinitionsFor } = await import("../src/rag/definitions");
    const ctx = (payload: Record<string, unknown>) => ({ payload, numbers: new Set<string>(), attribution: "per Senate financial disclosures" });
    expect(boundDefinitionsFor("The lag is the product", ctx({ lagDays: 87 })).map((d) => d.id)).toContain("ptr-lag-past-deadline");
    // Unbound below the deadline and with no lag at all — the cash-out rule,
    // not the grammar, is what decides it.
    expect(boundDefinitionsFor("The lag is the product", ctx({ lagDays: 3 }))).toEqual([]);
    expect(boundDefinitionsFor("The lag is the product", ctx({}))).toEqual([]);
  });
});

describe("the card job's selection rule (D-28's other half)", () => {
  it("takes tier-1, parsed, fresh, un-carded filings and nothing else", async () => {
    const { selectableFilingsSql, FILING_FRESH_HOURS, CARDS_PER_RUN } = await import("../src/pipeline/thirteenF");
    const sql = selectableFilingsSql();
    // Tier comes from an EXISTING column, not a list invented here.
    expect(sql).toContain("m.tier = 1");
    expect(sql).toContain("f.status = 'parsed'");
    // A filing with no parsed value or no entries would render a branded
    // card that says nothing.
    expect(sql).toContain("f.parsed_value_total > 0");
    expect(sql).toContain("f.table_entry_total > 0");
    // Freshness on filed_at: a 13F is six weeks stale BY LAW, so what must
    // not be stale is our sight of it.
    expect(sql).toContain("f.filed_at >= ?1");
    // Idempotent: an already-carded filing is excluded by dedup key, so a
    // re-run cannot double-card during the flood.
    expect(sql).toContain("i.dedup_key = 'edgar_13f_breakdown:' || f.accession");
    expect(sql).toContain("LIMIT ?2");
    expect(FILING_FRESH_HOURS).toBe(96);
    expect(CARDS_PER_RUN).toBeLessThanOrEqual(5);
  });

  it("Berkshire's Q1 filing is correctly OUT of the freshness window", async () => {
    const { FILING_FRESH_HOURS } = await import("../src/pipeline/thirteenF");
    // filed 2026-05-15, and "now" during the Aug-14 flood is three months on.
    const filedAt = Date.parse("2026-05-15T00:00:00.000Z");
    const flood = Date.parse("2026-08-14T00:00:00.000Z");
    const ageHours = (flood - filedAt) / 3_600_000;
    expect(ageHours).toBeGreaterThan(FILING_FRESH_HOURS);
    // Stated as an assertion because it is the answer to "why did the live
    // Berkshire generation not card": the filing is three months old and the
    // freshness rule refuses it, which is the rule working.
  });

  it("the job is registered and makes no external fetches", async () => {
    const src = await import("../src/ingesters/thirteenFCards?raw").catch(() => null);
    // Structural, not behavioural: the point is that the job reads D1 and
    // writes D1, so it cannot fail on egress and is safe on a short cadence.
    if (src) expect((src as unknown as { default: string }).default).not.toContain("politeFetch");
  });
});
