import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { classLetter, resolveSymbol } from "../src/lib/symbol";

// p6-02 / A2, ruled B-10.4. The resolution order is: filing-supplied symbol,
// then the CIK map, then the issuer name as filed. Never a guess, never a
// symbol inferred from a name, and always auditable.

const seed = async (
  cik: number, name: string, ticker: string, exchange = "NYSE", alts = "", source = "sec_primary",
) =>
  env.DB.prepare(
    `INSERT INTO issuers (cik, name, ticker, exchange, public_float, updated_at, ticker_source, ticker_alts)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(cik) DO UPDATE SET ticker=excluded.ticker, ticker_alts=excluded.ticker_alts`,
  ).bind(cik, name, ticker, exchange, 1e10, "2026-08-08T00:00:00.000Z", source, alts).run();

describe("resolveSymbol — the order in B-10.4", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM issuers`).run();
  });

  it("a symbol the FILING states outranks everything we hold", async () => {
    await seed(70858, "BANK OF AMERICA CORP", "BAC");
    const r = await resolveSymbol(env, { filingSymbol: "MGNI", cik: 70858, issuerName: "MAGNITE, INC." });
    expect(r).toMatchObject({ ticker: "MGNI", label: "$MGNI", source: "filing" });
  });

  it("no filing symbol falls to the CIK map — the Form 144 and 8-K case", async () => {
    await seed(1037868, "AMETEK INC/", "AME");
    const r = await resolveSymbol(env, { cik: 1037868, issuerName: "AMETEK INC/" });
    expect(r).toMatchObject({ ticker: "AME", label: "$AME", source: "cik_map" });
  });

  it("an unknown CIK prints the issuer name as filed, and never a guess", async () => {
    const r = await resolveSymbol(env, { cik: 999999999, issuerName: "SOME PRIVATE ISSUER LLC" });
    expect(r).toEqual({ ticker: null, label: "SOME PRIVATE ISSUER LLC", source: "issuer_name" });
  });

  it("no CIK at all still resolves to something honest", async () => {
    const r = await resolveSymbol(env, { issuerName: "Butterfly Network" });
    expect(r).toEqual({ ticker: null, label: "Butterfly Network", source: "issuer_name" });
  });

  it("a stored preferred series NEVER becomes a cashtag, whatever is in the table", async () => {
    // The last line of defence for B-15.4: even if a bad row survives ingest,
    // the card falls back to the name rather than printing $MER-PK.
    await seed(70858, "BANK OF AMERICA CORP", "MER-PK");
    const r = await resolveSymbol(env, { cik: 70858, issuerName: "BANK OF AMERICA CORP" });
    expect(r).toEqual({ ticker: null, label: "BANK OF AMERICA CORP", source: "issuer_name" });
  });

  it("a filing-supplied symbol is held to the same rule", async () => {
    const r = await resolveSymbol(env, { filingSymbol: "WFC-PZ", issuerName: "WELLS FARGO & COMPANY/MN" });
    expect(r.ticker).toBeNull();
    expect(r.source).toBe("issuer_name");
  });

  it("B-10.4 tier 2: the filing's own class title picks the class", async () => {
    await seed(1067983, "BERKSHIRE HATHAWAY INC", "BRK-A", "NYSE", "BRK-B", "sec_share_class");
    const b = await resolveSymbol(env, {
      cik: 1067983, securitiesClass: "Class B Common Stock", issuerName: "BERKSHIRE HATHAWAY INC",
    });
    expect(b).toMatchObject({ ticker: "BRK-B", source: "cik_map_class" });

    // With no class named, the deterministic default stands and the ambiguity
    // is RECORDED rather than hidden.
    const d = await resolveSymbol(env, { cik: 1067983, issuerName: "BERKSHIRE HATHAWAY INC" });
    expect(d).toMatchObject({ ticker: "BRK-A", source: "cik_map", ambiguity: "BRK-A,BRK-B" });
  });

  it("classLetter reads a class designation and nothing else", () => {
    expect(classLetter("Class B Common Stock")).toBe("B");
    expect(classLetter("class a common")).toBe("A");
    expect(classLetter("Common")).toBeNull();
    expect(classLetter("Class AB Units")).toBeNull();
    expect(classLetter(null)).toBeNull();
  });
});
