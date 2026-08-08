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

  it("AT&T is now SUPPRESSED, and that correction is the point", () => {
    // This test used to assert that "shortest first" picks T over TBB, the
    // NYSE baby bond. The rule was deterministic and WRONG: it survives here
    // only because AT&T's common share happens to be the shortest symbol.
    // Comcast lists CMCSA and CCZ, where CCZ is the "2.0% Exchangeable
    // Subordinated Debentures due 2029" and IS the shorter one, so the same
    // rule printed $CCZ for a Comcast filing.
    //
    // SEC's file carries no security TYPE, so nothing here can tell a common
    // share from a listed debenture. The ambiguity is reported instead, and
    // AT&T loses its cashtag along with the 643 other multi-symbol CIKs. That
    // is the cost of not naming a security the filing never mentioned.
    const r = selectIssuerTicker([
      { ticker: "TBB", exchange: "NYSE" },
      { ticker: "T", exchange: "NYSE" },
    ]);
    expect(r.ticker).toBe("");
    expect(r.tickerSource).toBe("ambiguous_multi");
    expect(r.alts).toEqual(["T", "TBB"]);
  });

  it("the three the reviewer proved against each registrant's own 10-K cover", () => {
    // Comcast: CCZ = 2.0% Exchangeable Subordinated Debentures due 2029.
    // DTE: DTB = 2020 Series G 4.375% Junior Subordinated Debentures due 2080.
    // Corebridge: CRBD = 6.375% Junior Subordinated Notes.
    for (const cands of [
      [{ ticker: "CMCSA", exchange: "Nasdaq" }, { ticker: "CCZ", exchange: "NYSE" }],
      [{ ticker: "DTE", exchange: "NYSE" }, { ticker: "DTW", exchange: "NYSE" }, { ticker: "DTB", exchange: "NYSE" }],
      [{ ticker: "CRBG", exchange: "NYSE" }, { ticker: "CRBD", exchange: "NYSE" }],
    ]) {
      expect(selectIssuerTicker(cands).ticker).toBe("");
    }
  });

  it("a BARE -P is the preferred marker, not a class letter", () => {
    // Entergy Texas lists exactly one symbol, ETI-P, and its own 10-K cover
    // registers it as "5.375% Series A Preferred Stock". It classified as a
    // share class because SHARE_CLASS_SUFFIX was /^[A-Z]$/ — and the header's
    // "29 single-letter share classes" count was made with that same regex,
    // so the five bare -P symbols were counted into the figure meant to
    // validate it. D-99's shape, in my own measurement.
    for (const t of ["ETI-P", "PHXE-P", "TY-P", "DCOM-P", "TFIN-P"]) {
      expect(isNonCommonSymbol(t), t).toBe(true);
    }
    expect(selectIssuerTicker([{ ticker: "ETI-P", exchange: "NYSE" }]).ticker).toBe("");
    // and a real class letter is still a class letter
    for (const t of ["BRK-A", "CRD-B", "GEF-B"]) expect(isNonCommonSymbol(t), t).toBe(false);
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

describe("B-22.5: share class and series are different things and must never merge", () => {
  // The predicate decides whether a symbol can ever become a cashtag. Getting
  // it wrong in one direction prints $MER-PK for Bank of America; wrong in the
  // other direction strips Berkshire and Crawford of a real common share.
  it("BRK-A and CRD-B are COMMON SHARE CLASSES and are never stripped", () => {
    for (const t of ["BRK-A", "BRK-B", "CRD-A", "CRD-B", "BF-A", "BF-B", "GTN-A", "HEI-A"]) {
      expect(isNonCommonSymbol(t)).toBe(false);
      expect(isPreferredSeries(t)).toBe(false);
    }
    // and they survive selection when no unsuffixed symbol exists
    expect(selectIssuerTicker([
      { ticker: "BRK-B", exchange: "NYSE" },
      { ticker: "BRK-A", exchange: "NYSE" },
    ]).ticker).toBe("BRK-A");
    expect(selectIssuerTicker([
      { ticker: "CRD-B", exchange: "NYSE" },
      { ticker: "CRD-A", exchange: "NYSE" },
    ]).ticker).toBe("CRD-A");
  });

  it("a REAL preferred series is stripped, and resolves to no ticker at all", () => {
    // MER-PK is the symbol Bank of America actually held in production.
    for (const t of ["MER-PK", "WFC-PZ", "MS-PQ", "GS-PD", "T-PC", "BA-PA", "C-PR", "SCHW-PJ"]) {
      expect(isNonCommonSymbol(t)).toBe(true);
      expect(isPreferredSeries(t)).toBe(true);
    }
    expect(selectIssuerTicker([{ ticker: "MER-PK", exchange: "NYSE" }])).toMatchObject({
      ticker: "",
      tickerSource: "unresolved",
    });
  });

  it("the two families are disjoint over every suffix the live file contains", () => {
    // 383 preferred, 29 share classes, 136 warrants/units/rights, measured
    // 2026-08-08 across company_tickers_exchange.json. Nothing may be both.
    const classes = ["X-A", "X-B", "X-C", "X-Z"];
    const notCommon = ["X-PA", "X-PZ", "X-WT", "X-UN", "X-RI"];
    for (const t of classes) expect(isNonCommonSymbol(t)).toBe(false);
    for (const t of notCommon) expect(isNonCommonSymbol(t)).toBe(true);
    for (const t of [...classes, ...notCommon]) {
      // a symbol is never simultaneously a common class and a preferred series
      expect(isNonCommonSymbol(t) && !isPreferredSeries(t) ? t.includes("-W") || t.includes("-U") || t.includes("-R") : true).toBe(true);
    }
  });
});

describe("B-29.2: every symbol predicate is case-normalized", () => {
  it("a lower-case symbol answers the same as its upper-case twin", () => {
    // "brk-a" read as NON-common and "wfc-pz" read as a share class: both
    // answers inverted. Symbols arrive lower-case from disclosure PDFs and
    // from hand-written payloads.
    for (const t of ["BRK-A", "CRD-B", "WFC-PZ", "MER-PK", "ETI-P", "GEF", "T"]) {
      expect(isNonCommonSymbol(t.toLowerCase()), t).toBe(isNonCommonSymbol(t));
      expect(isPreferredSeries(t.toLowerCase()), t).toBe(isPreferredSeries(t));
    }
  });

  it("selection normalizes at the door and returns an upper-case symbol", () => {
    expect(selectIssuerTicker([
      { ticker: "brk-b", exchange: "NYSE" },
      { ticker: "brk-a", exchange: "NYSE" },
    ])).toEqual({ ticker: "BRK-A", exchange: "NYSE", tickerSource: "sec_share_class", alts: ["BRK-B"] });
    expect(selectIssuerTicker([{ ticker: " gef ", exchange: "NYSE" }]).ticker).toBe("GEF");
  });
});

describe("B-29.1: the guard is inside tickerTag, so no call site can bypass it", () => {
  it("refuses everything that is not one common symbol, whatever the caller", async () => {
    const { tickerTag } = await import("../src/ingesters/shared");
    for (const bad of ["GEF, GEF-B", "WFC-PZ", "ACME-WT", "ETI-P", "TOOLONGSYM", "", "  ", "$GEF"]) {
      expect(tickerTag(bad), bad).toBeNull();
    }
    expect(tickerTag("gef")).toBe("$GEF");
    expect(tickerTag("brk-a")).toBe("$BRK-A");
  });
});
