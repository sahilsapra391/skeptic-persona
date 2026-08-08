import { describe, expect, it } from "vitest";
import { isNonCommonSymbol, isPreferredSeries, selectIssuerTicker } from "../src/ingesters/issuers";

// p6-02 / B-15.4. THE CANDIDATE SETS BELOW ARE REAL, taken verbatim from
// SEC's company_tickers_exchange.json on 2026-08-08. Each of these CIKs held
// the WRONG symbol in production because the upsert was keyed on cik while the
// file is one-to-many, and ON CONFLICT DO UPDATE took whichever row came last.

const REAL: Array<[string, number, Array<{ ticker: string; exchange: string }>, string, string]> = [
  ["BANK OF AMERICA", 70858, [
    { ticker: "BAC", exchange: "NYSE" }, { ticker: "BML-PG", exchange: "NYSE" },
    { ticker: "BML-PL", exchange: "NYSE" }, { ticker: "BAC-PB", exchange: "NYSE" },
    { ticker: "BAC-PK", exchange: "NYSE" }, { ticker: "BAC-PE", exchange: "NYSE" },
    { ticker: "BAC-PL", exchange: "NYSE" }, { ticker: "BAC-PM", exchange: "NYSE" },
    { ticker: "BAC-PN", exchange: "NYSE" }, { ticker: "BAC-PO", exchange: "NYSE" },
    { ticker: "BAC-PP", exchange: "NYSE" }, { ticker: "BAC-PQ", exchange: "NYSE" },
    { ticker: "BAC-PS", exchange: "NYSE" }, { ticker: "BACRP", exchange: "OTC" },
    { ticker: "BML-PH", exchange: "NYSE" }, { ticker: "BML-PJ", exchange: "NYSE" },
    { ticker: "MER-PK", exchange: "NYSE" },
  ], "BAC", "MER-PK"],
  ["WELLS FARGO", 72971, [
    { ticker: "WFC", exchange: "NYSE" }, { ticker: "WFC-PY", exchange: "NYSE" },
    { ticker: "WFC-PL", exchange: "NYSE" }, { ticker: "WFC-PC", exchange: "NYSE" },
    { ticker: "WFCNP", exchange: "OTC" }, { ticker: "WFC-PA", exchange: "NYSE" },
    { ticker: "WFC-PD", exchange: "NYSE" }, { ticker: "WFC-PZ", exchange: "NYSE" },
  ], "WFC", "WFC-PZ"],
  ["MORGAN STANLEY", 895421, [
    { ticker: "MS", exchange: "NYSE" }, { ticker: "MS-PK", exchange: "NYSE" },
    { ticker: "MS-PE", exchange: "NYSE" }, { ticker: "MS-PA", exchange: "NYSE" },
    { ticker: "MS-PF", exchange: "NYSE" }, { ticker: "MS-PI", exchange: "NYSE" },
    { ticker: "MS-PL", exchange: "NYSE" }, { ticker: "MS-PO", exchange: "NYSE" },
    { ticker: "MS-PP", exchange: "NYSE" }, { ticker: "MS-PQ", exchange: "NYSE" },
  ], "MS", "MS-PQ"],
  ["GOLDMAN SACHS", 886982, [
    { ticker: "GS", exchange: "NYSE" }, { ticker: "GSCE", exchange: "OTC" },
    { ticker: "GS-PA", exchange: "NYSE" }, { ticker: "GS-PC", exchange: "NYSE" },
    { ticker: "GS-PD", exchange: "NYSE" },
  ], "GS", "GS-PD"],
  ["AT&T", 732717, [
    { ticker: "T", exchange: "NYSE" }, { ticker: "TBB", exchange: "NYSE" },
    { ticker: "T-PA", exchange: "NYSE" }, { ticker: "T-PC", exchange: "NYSE" },
  ], "T", "T-PC"],
  ["BOEING", 12927, [
    { ticker: "BA", exchange: "NYSE" }, { ticker: "BA-PA", exchange: "NYSE" },
  ], "BA", "BA-PA"],
  ["CITIGROUP", 831001, [
    { ticker: "C", exchange: "NYSE" }, { ticker: "C-PN", exchange: "NYSE" },
    { ticker: "C-PR", exchange: "NYSE" },
  ], "C", "C-PR"],
  ["CHARLES SCHWAB", 316709, [
    { ticker: "SCHW", exchange: "NYSE" }, { ticker: "SCHW-PD", exchange: "NYSE" },
    { ticker: "SCHW-PJ", exchange: "NYSE" },
  ], "SCHW", "SCHW-PJ"],
];

describe("B-15.4 kill-test: the eight issuers that were wrong in production", () => {
  for (const [name, cik, candidates, expected, wasWrong] of REAL) {
    it(`${name} (CIK ${cik}) resolves ${expected}, not ${wasWrong}`, () => {
      const r = selectIssuerTicker(candidates);
      expect(r.ticker).toBe(expected);
      expect(r.tickerSource).toBe("sec_primary");
      expect(r.ticker).not.toBe(wasWrong);
    });
  }

  it("NO candidate set anywhere resolves to a preferred series, warrant, unit or right", () => {
    for (const [, , candidates] of REAL) {
      expect(isNonCommonSymbol(selectIssuerTicker(candidates).ticker)).toBe(false);
    }
  });

  it("AT&T is the case that shows why alphabetical alone is not enough", () => {
    // `TBB` is unsuffixed and on NYSE, and it is a baby bond, not the common
    // share. Sorting by length first is what excludes it on purpose rather
    // than by luck of the alphabet.
    expect(selectIssuerTicker([
      { ticker: "TBB", exchange: "NYSE" },
      { ticker: "T", exchange: "NYSE" },
    ]).ticker).toBe("T");
  });
});

describe("the selection is total, deterministic and order-independent", () => {
  it("dual-class common with NO unsuffixed symbol takes the first class", () => {
    // Berkshire lists only BRK-A and BRK-B. Refusing both would drop the
    // cashtag on one of the largest filers we cover; either is a real common
    // share class, so the choice just has to be deterministic.
    const r = selectIssuerTicker([
      { ticker: "BRK-B", exchange: "NYSE" },
      { ticker: "BRK-A", exchange: "NYSE" },
    ]);
    expect(r).toEqual({ ticker: "BRK-A", exchange: "NYSE", tickerSource: "sec_share_class", alts: ["BRK-B"] });
  });

  it("preferred-only resolves to NO ticker, so the lane falls back to the issuer name", () => {
    // CONSUMERS ENERGY CO lists exactly one symbol, CMS-PB, a preferred series.
    const r = selectIssuerTicker([{ ticker: "CMS-PB", exchange: "NYSE" }]);
    expect(r.ticker).toBe("");
    expect(r.tickerSource).toBe("unresolved");
  });

  it("warrants, units and rights are not common shares either", () => {
    for (const t of ["ACME-WT", "ACME-UN", "ACME-RI"]) {
      expect(isNonCommonSymbol(t)).toBe(true);
      expect(selectIssuerTicker([{ ticker: t, exchange: "NYSE" }]).ticker).toBe("");
    }
  });

  it("row order cannot change the answer", () => {
    const c = REAL[0]![2];
    const forward = selectIssuerTicker(c);
    const reversed = selectIssuerTicker(c.slice().reverse());
    expect(forward).toEqual(reversed);
  });

  it("a major-exchange listing outranks an OTC one", () => {
    expect(selectIssuerTicker([
      { ticker: "AAA", exchange: "OTC" },
      { ticker: "BBB", exchange: "Nasdaq" },
    ])).toEqual({ ticker: "BBB", exchange: "Nasdaq", tickerSource: "sec_primary", alts: [] });
  });

  it("OTC-only still resolves, but says so", () => {
    expect(selectIssuerTicker([{ ticker: "AAA", exchange: "OTC" }]).tickerSource).toBe("sec_primary_otc");
  });

  it("an empty or blank candidate set never throws", () => {
    expect(selectIssuerTicker([]).ticker).toBe("");
    expect(selectIssuerTicker([{ ticker: "", exchange: "" }]).ticker).toBe("");
  });

  it("share classes are allowed; preferred series never are", () => {
    expect(isNonCommonSymbol("BRK-A")).toBe(false);
    expect(isNonCommonSymbol("CRD-B")).toBe(false);
    expect(isPreferredSeries("WFC-PZ")).toBe(true);
    expect(isPreferredSeries("BRK-A")).toBe(false);
    expect(isNonCommonSymbol("BAC")).toBe(false);
  });
});

describe("lookupIssuer survives either deploy order (D-43's general form)", () => {
  it("returns a row against the PRE-0071 schema, with ticker_alts absent", async () => {
    // Workers Builds deploys on merge; migrations are applied by hand. There
    // is therefore a window where the new bundle meets the old schema, and
    // this function sits on the 8-K float-gate path — the hottest lane in the
    // pipeline. A SELECT naming a column that does not exist would throw for
    // every filing in that window.
    //
    // Proven against the real schema rather than asserted in a comment: the
    // column is genuinely dropped here and restored afterwards.
    const { env } = await import("cloudflare:test");
    const { lookupIssuer } = await import("../src/ingesters/issuers");
    await env.DB.prepare(
      `INSERT INTO issuers (cik, name, ticker, exchange, public_float, updated_at)
       VALUES (7, 'ACME', 'ACME', 'NYSE', 1, 'x')
       ON CONFLICT(cik) DO UPDATE SET ticker = 'ACME'`,
    ).run();
    await env.DB.prepare(`ALTER TABLE issuers DROP COLUMN ticker_alts`).run();
    try {
      const row = await lookupIssuer(env, 7);
      expect(row?.ticker).toBe("ACME");
      expect(row?.tickerAlts).toBeUndefined();
    } finally {
      await env.DB.prepare(`ALTER TABLE issuers ADD COLUMN ticker_alts TEXT NOT NULL DEFAULT ''`).run();
    }
  });
});
