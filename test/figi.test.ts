import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import BATCH1 from "./fixtures/openfigi-batch1.json.fixture?raw";
import BATCH2 from "./fixtures/openfigi-batch2.json.fixture?raw";
import { displayFor, FIGI_BATCH, resolveCusipBatch, selectUsListing } from "../src/lib/figi";

// Fixtures are LIVE openFIGI responses, 2026-08-04, no API key, for the first
// 20 distinct CUSIPs of the MERIDIAN Q2 filing (batches of 10).

const NOW = new Date("2026-08-04T19:00:00.000Z");
type FigiRow = { data?: Array<{ ticker?: string | null; name?: string | null; exchCode?: string | null }> };

describe("selectUsListing — the selection rule, proven on live data", () => {
  const b2 = JSON.parse(BATCH2 as string) as FigiRow[];

  it("takes the US composite when present, wherever it sits", () => {
    // FIRST HORIZON: data[0..4] are FT2 on German venues; FHN/US is at
    // position 6. data[0] would put a GERMAN ticker on the account.
    const fhn = selectUsListing(b2[9]!.data);
    expect(fhn.ticker).toBe("FHN");
  });

  it("returns NO ticker when no US listing exists — never a foreign one", () => {
    // EXXON via this CUSIP: eleven entries, zero exchCode US (Kazakh, Uzbek,
    // German venues). Any pick would be wrong; the issuer name is the
    // licensed fallback.
    const xom = selectUsListing(b2[7]!.data);
    expect(xom.ticker).toBeNull();
    expect((b2[7]!.data ?? []).some((d) => d.exchCode === "US")).toBe(false);
  });

  it("maps the ordinary case first-hit", () => {
    const b1 = JSON.parse(BATCH1 as string) as FigiRow[];
    const abnb = selectUsListing(b1[0]!.data);
    expect(abnb.ticker).toBe("ABNB");
  });

  it("empty and missing data fail open", () => {
    expect(selectUsListing(undefined).ticker).toBeNull();
    expect(selectUsListing([]).ticker).toBeNull();
  });
});

describe("displayFor — fail-open is issuer name, never a raw CUSIP", () => {
  it("prefers the ticker, falls back to the filing's own issuer name", () => {
    expect(displayFor("ABNB", "AIRBNB INC")).toBe("$ABNB");
    expect(displayFor(null, "EXXON MOBIL CORP")).toBe("EXXON MOBIL CORP");
    expect(displayFor("", "EXXON MOBIL CORP")).toBe("EXXON MOBIL CORP");
  });
});

describe("resolveCusipBatch", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM cusip_map").run();
  });

  const CUSIPS10 = ["009066101", "02079K107", "023135106", "037833100", "N07059210",
                    "084670702", "110122108", "11135F101", "127387108", "14448C104"];

  it("caches hits AND misses; a second call has nothing left to ask", async () => {
    fetchMock.get("https://api.openfigi.com").intercept({ path: "/v3/mapping", method: "POST" }).reply(200, BATCH1 as string);
    const n = await resolveCusipBatch(env as never, CUSIPS10, NOW);
    expect(n).toBe(10);
    const rows = await env.DB.prepare(`SELECT cusip, ticker, source FROM cusip_map ORDER BY cusip`).all<{ cusip: string; ticker: string | null; source: string }>();
    expect(rows.results.length).toBe(10);
    const abnb = rows.results.find((r) => r.cusip === "009066101")!;
    expect(abnb.ticker).toBe("ABNB");
    expect(abnb.source).toBe("openfigi");
    // The CINS miss is cached as nodata — asked once, not every tick.
    const cins = rows.results.find((r) => r.cusip === "N07059210")!;
    expect(cins.ticker).toBeNull();
    expect(cins.source).toBe("openfigi_nodata");
  });

  it("caps a call at FIGI_BATCH jobs", async () => {
    let jobsSeen = 0;
    fetchMock.get("https://api.openfigi.com").intercept({ path: "/v3/mapping", method: "POST" }).reply(200, (opts) => {
      jobsSeen = (JSON.parse(String(opts.body)) as unknown[]).length;
      return BATCH1 as string;
    });
    await resolveCusipBatch(env as never, [...CUSIPS10, "EXTRA00001", "EXTRA00002"], NOW);
    expect(jobsSeen).toBe(FIGI_BATCH);
  });

  it("a transport failure caches NOTHING — a network error is not evidence about the CUSIP", async () => {
    fetchMock.get("https://api.openfigi.com").intercept({ path: "/v3/mapping", method: "POST" }).reply(503, "unavailable");
    const n = await resolveCusipBatch(env as never, CUSIPS10, NOW);
    expect(n).toBe(0);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cusip_map`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("a misaligned response caches NOTHING — zipping wrong rows is a fabrication vector", async () => {
    fetchMock.get("https://api.openfigi.com").intercept({ path: "/v3/mapping", method: "POST" }).reply(200, JSON.stringify([{ data: [] }]));
    const n = await resolveCusipBatch(env as never, CUSIPS10, NOW);
    expect(n).toBe(0);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cusip_map`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("the signed watchlist seed (migration 0061)", () => {
  it("carries 36 managers: 15 tier-1 cards, 21 tier-2 digest", async () => {
    const tiers = await env.DB.prepare(
      `SELECT tier, COUNT(*) AS n FROM managers_13f GROUP BY tier ORDER BY tier`,
    ).all<{ tier: number; n: number }>();
    expect(tiers.results).toEqual([{ tier: 1, n: 15 }, { tier: 2, n: 21 }]);
  });

  it("holds the ACTIVELY-FILING entities the live disambiguation found", async () => {
    // The four dead-entity traps plus the renamed filer — each of these CIKs
    // is the verified active one, and getting any wrong repeats the class this
    // seed exists to avoid.
    const expected: Record<string, string> = {
      "1656456": "Appaloosa LP",
      "1061768": "BAUPOST GROUP LLC/MA",
      "1345471": "TRIAN FUND MANAGEMENT, L.P.",
      "1418814": "ValueAct Holdings, L.P.",
      "1489933": "DME Capital Management, LP",
    };
    for (const [cik, name] of Object.entries(expected)) {
      const row = await env.DB.prepare(`SELECT name FROM managers_13f WHERE cik = ?1`).bind(cik).first<{ name: string }>();
      expect(row?.name, cik).toBe(name);
    }
  });

  it("coverage_start is NULL until observation actually starts", async () => {
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM managers_13f WHERE coverage_start IS NOT NULL`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("cashtags are a fabrication vector, so they are gated like a number", () => {
  // Owner ruling 2026-08-06: "Tickers render as $TICKER in all copy, sourced
  // ONLY from cusip_map via the payload. Unmapped: issuer name, never a
  // guessed ticker."
  //
  // Measured the same day: 2,795 distinct CUSIPs in holdings_13f, 370 in
  // cusip_map, so 87% are unmapped. The unmapped branch is the COMMON path
  // here, not the edge case, which is exactly why it must never guess.

  it("displayFor cannot emit a cashtag it was not given", () => {
    // Berkshire's real Q1 2026 top ten: nine mapped, CHUBB unmapped.
    expect(displayFor("AAPL", "APPLE INC")).toBe("$AAPL");
    expect(displayFor("KHC", "KRAFT HEINZ CO")).toBe("$KHC");
    // The unmapped one renders its filed issuer name. Not "$CB", which is the
    // real Chubb ticker and precisely the plausible guess that must not happen.
    expect(displayFor(null, "CHUBB LTD SWITZ")).toBe("CHUBB LTD SWITZ");
    expect(displayFor("", "CHUBB LTD SWITZ")).toBe("CHUBB LTD SWITZ");
    expect(displayFor(undefined, "CHUBB LTD SWITZ")).not.toContain("$");
  });

  it("KILL-TEST: a ticker absent from the payload rejects the draft", async () => {
    const { entityCheck } = await import("../src/rag/validate");
    const payload = { manager: "BERKSHIRE HATHAWAY INC", ticker: "AAPL", issuer: "APPLE INC" };
    // The licensed one passes.
    expect(entityCheck("$AAPL is the largest position", payload)).toEqual([]);
    // A ticker the payload never stated is refused, exactly as an unlicensed
    // number would be. $CB is the trap: a real ticker for a real holding whose
    // CUSIP we simply have not mapped.
    const issues = entityCheck("$CB is the largest position", payload);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.rule).toBe("entity");
    expect(issues[0]!.detail).toContain("$CB");
  });

  it("KILL-TEST: the unmapped rendering survives the validator, so fail-open is real", async () => {
    const { entityCheck } = await import("../src/rag/validate");
    // The issuer name comes from the filing and is in the payload, so the
    // fail-open path is not merely safe in principle: it validates.
    const payload = { issuer: "CHUBB LTD SWITZ", value_usd: 11162836215 };
    expect(entityCheck(`${displayFor(null, "CHUBB LTD SWITZ")} holds steady`, payload)).toEqual([]);
  });
});
