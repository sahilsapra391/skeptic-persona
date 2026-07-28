import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import TICKERS from "./fixtures/sec-company-tickers.json.fixture?raw";
import FLOATS from "./fixtures/sec-float-frame.json.fixture?raw";
import {
  DEFAULT_MIN_FLOAT_USD,
  keepIssuer,
  MAJOR_EXCHANGES,
  parseFloatFrame,
  parseTickerFile,
  type Issuer,
} from "../src/ingesters/issuers";
import { ingestForTest } from "../src/ingesters/edgar8k";
import { SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";

// Real rows from SEC's own files, captured 2026-07-28.

const issuer = (over: Partial<Issuer>): Issuer => ({
  cik: 1,
  name: "TEST CO",
  ticker: "TST",
  exchange: "Nasdaq",
  publicFloat: 5_000_000_000,
  ...over,
});

describe("parseTickerFile", () => {
  it("reads columns by NAME, not position", () => {
    const rows = parseTickerFile(TICKERS);
    expect(rows.find((r) => r.cik === 1045810)).toMatchObject({ ticker: "NVDA", exchange: "Nasdaq" });

    // SEC publishes the header so callers do not hardcode positions. Reorder
    // the columns and the parser must follow; a silent reorder would file
    // every 8-K under the wrong exchange.
    const doc = JSON.parse(TICKERS) as { fields: string[]; data: unknown[][] };
    const swapped = {
      fields: [doc.fields[3], doc.fields[0], doc.fields[1], doc.fields[2]],
      data: doc.data.map((r) => [r[3], r[0], r[1], r[2]]),
    };
    expect(parseTickerFile(JSON.stringify(swapped)).find((r) => r.cik === 1045810)).toMatchObject({
      ticker: "NVDA",
      exchange: "Nasdaq",
    });
  });

  it("keeps a listed filer that carries no exchange, as empty not missing", () => {
    const rows = parseTickerFile(TICKERS);
    const noExchange = rows.find((r) => r.cik === 803016);
    expect(noExchange).toBeTruthy();
    expect(noExchange!.exchange).toBe("");
  });

  it("returns nothing rather than guessing when the header is unusable", () => {
    expect(parseTickerFile('{"data":[[1,"X","X","Nasdaq"]]}')).toEqual([]);
    expect(parseTickerFile("{}")).toEqual([]);
    expect(parseTickerFile('{"fields":["cik","name","ticker","exchange"],"data":[]}')).toEqual([]);
  });
});

describe("parseFloatFrame", () => {
  it("treats a zero float as UNKNOWN, never as a company worth nothing", () => {
    // A pre-IPO measurement date reports 0. Reading that as "tiny" would
    // silence a spinoff's first 8-K, which is exactly the news worth having.
    expect(FLOATS).toContain("PRE IPO SPINOFF");
    const floats = parseFloatFrame(FLOATS);
    expect(floats.has(9_999_001)).toBe(false);
    expect(floats.get(1_045_810)?.val).toBe(4_000_000_000_000);
  });

  it("keeps the newest measurement per issuer", () => {
    const body = JSON.stringify({
      data: [
        { cik: 5, end: "2024-06-30", val: 100 },
        { cik: 5, end: "2025-06-30", val: 900 },
        { cik: 5, end: "2023-06-30", val: 500 },
      ],
    });
    expect(parseFloatFrame(body).get(5)).toEqual({ end: "2025-06-30", val: 900 });
  });

  it("skips rows it cannot read instead of coercing them", () => {
    const body = JSON.stringify({ data: [{ cik: "abc", end: "2025-06-30", val: 5 }, { cik: 6, val: 5 }, { cik: 7, end: "2025-06-30" }] });
    expect(parseFloatFrame(body).size).toBe(0);
  });
});

describe("keepIssuer — the gate fails OPEN on unknowns", () => {
  it("suppresses a filer with no listing at all", () => {
    // BlackRock Private Credit Fund, KKR Infrastructure Conglomerate and
    // friends: real 8-K filers, no tradeable security.
    expect(keepIssuer(issuer({ exchange: "" }))).toEqual({ keep: false, reason: "not_listed" });
  });

  it("suppresses OTC, where the shells live", () => {
    expect(keepIssuer(issuer({ exchange: "OTC" })).keep).toBe(false);
    expect(keepIssuer(issuer({ exchange: "OTC" })).reason).toBe("minor_exchange");
  });

  it("suppresses a major-exchange issuer whose OWN reported float is below the floor", () => {
    const small = issuer({ publicFloat: 50_000_000 });
    expect(keepIssuer(small)).toEqual({ keep: false, reason: "below_float" });
    // The floor is configurable, and lowering it lets the same issuer through.
    expect(keepIssuer(small, 10_000_000).keep).toBe(true);
  });

  it("KEEPS an issuer it has never heard of", () => {
    // Absence is not evidence of smallness: the table refreshes weekly and a
    // fresh listing shows up late. Only a positive finding suppresses.
    expect(keepIssuer(null)).toEqual({ keep: true, reason: "float_unknown" });
  });

  it("KEEPS a major-exchange issuer whose float is unknown", () => {
    // Donaldson and Estee Lauder have June/July fiscal years, so their float
    // instant falls outside the frames we union. A rule reading missing-as-
    // zero would silence two large caps.
    expect(keepIssuer(issuer({ publicFloat: null }))).toEqual({ keep: true, reason: "float_unknown" });
  });

  it("keeps a large issuer on every major exchange", () => {
    for (const exchange of MAJOR_EXCHANGES) {
      expect(keepIssuer(issuer({ exchange })).keep, exchange).toBe(true);
    }
  });

  it("uses a floor that is a real threshold, not zero", () => {
    // A zero floor would make the float half of the gate inert.
    expect(DEFAULT_MIN_FLOAT_USD).toBeGreaterThan(0);
  });
});

describe("the gate in the 8-K ingest path", () => {
  async function seedIssuer(cik: number, exchange: string, float: number | null) {
    await env.DB.prepare(
      `INSERT INTO issuers (cik, name, ticker, exchange, public_float, updated_at)
       VALUES (?1, 'SEEDED CO', 'SEED', ?2, ?3, '2026-07-28T00:00:00.000Z')
       ON CONFLICT(cik) DO UPDATE SET exchange = excluded.exchange, public_float = excluded.public_float`,
    )
      .bind(cik, exchange, float)
      .run();
  }

  async function scoreOf(cik: string) {
    const row = await env.DB.prepare(
      `SELECT score, status FROM items WHERE source = 'edgar_8k' AND json_extract(payload,'$.cik') = ?1`,
    )
      .bind(cik)
      .first<{ score: number; status: string }>();
    return row;
  }

  it("logs a non-traded fund's 8-K instead of queueing it, and still keeps the filing", async () => {
    // A 4.02 non-reliance item is the highest-grade 8-K there is, so if the
    // gate can hold THIS one it holds anything.
    await seedIssuer(1234567, "", null);
    const entry = {
      accession: "0000000000-26-000001",
      company: "SOME PRIVATE CREDIT FUND",
      cik: "1234567",
      formType: "8-K",
      items: [{ code: "4.02", title: "Non-Reliance on Previously Issued Financial Statements" }],
      filedIso: new Date().toISOString(),
      indexUrl: "https://www.sec.gov/x",
    };
    await ingestForTest(env, [entry]);

    const row = await scoreOf("1234567");
    // The filing is NOT discarded: it is in the lake, just not interrupting.
    expect(row).toBeTruthy();
    expect(row!.status).toBe("logged");
    expect(row!.score).toBe(SCORE_LOG_ONLY);
  });

  it("lets the same filing through for a large listed issuer", async () => {
    await seedIssuer(7654321, "Nasdaq", 5_000_000_000);
    await ingestForTest(env, [
      {
        accession: "0000000000-26-000002",
        company: "BIG LISTED CO",
        cik: "7654321",
        formType: "8-K",
        items: [{ code: "4.02", title: "Non-Reliance on Previously Issued Financial Statements" }],
        filedIso: new Date().toISOString(),
        indexUrl: "https://www.sec.gov/y",
      },
    ]);
    const row = await scoreOf("7654321");
    expect(row!.score).toBeGreaterThanOrEqual(SCORE_POSTABLE);
    expect(row!.status).toBe("new");
  });

  it("lets an issuer it has never seen through", async () => {
    // Fails OPEN. A fresh listing the weekly refresh has not picked up yet
    // must not be silenced.
    await ingestForTest(env, [
      {
        accession: "0000000000-26-000003",
        company: "BRAND NEW LISTING INC",
        cik: "5550000",
        formType: "8-K",
        items: [{ code: "4.02", title: "Non-Reliance on Previously Issued Financial Statements" }],
        filedIso: new Date().toISOString(),
        indexUrl: "https://www.sec.gov/z",
      },
    ]);
    const row = await scoreOf("5550000");
    expect(row!.status).toBe("new");
  });
});
