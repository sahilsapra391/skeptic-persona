import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FIXTURE from "./fixtures/cftc-cot.json?raw";
import {
  BIG_NET_CHANGE,
  cotUrl,
  draftCot,
  parseCot,
  pollCftc,
  scoreCot,
  SOURCE,
  WATCHED_CONTRACTS,
  type CotRow,
} from "../src/ingesters/cftc";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { renderPost } from "../src/templates/render";

// Live fixture captured 2026-07-27T23:25Z. THIS is the parse contract.
const NOW = new Date("2026-07-27T23:30:00Z");
const parsed = parseCot(FIXTURE);

describe("cotUrl", () => {
  it("asks for the watchlist by CFTC's own verbatim contract names", () => {
    const url = cotUrl();
    // CFTC's names are idiosyncratic ("NASDAQ MINI", "ULTRA UST 10Y"); a
    // near-miss returns an empty set with a healthy 200.
    // URLSearchParams encodes spaces as "+", which decodeURIComponent leaves
    // alone; normalise before comparing.
    const readable = decodeURIComponent(url).replace(/\+/g, " ");
    for (const c of WATCHED_CONTRACTS) expect(readable).toContain(`'${c}'`);
    expect(readable).toContain("report_date_as_yyyy_mm_dd DESC");
  });
});

describe("parseCot (live fixture)", () => {
  it("parses E-MINI S&P 500 with CFTC's own numbers", () => {
    const row = parsed.find((r) => r.contract === "E-MINI S&P 500")!;
    expect(row.openInterest).toBeGreaterThan(1_000_000);
    expect(row.levLong).not.toBeNull();
    expect(row.levShort).not.toBeNull();
    // net is the ONLY arithmetic we do.
    expect(row.levNet).toBe((row.levLong ?? 0) - (row.levShort ?? 0));
  });

  it("derives the weekly net change from CFTC's own two deltas", () => {
    const row = parsed.find((r) => r.changeLevLong !== null && r.changeLevShort !== null)!;
    expect(row.changeLevNet).toBe((row.changeLevLong ?? 0) - (row.changeLevShort ?? 0));
  });

  it("covers the whole watchlist and drops undated rows", () => {
    expect(new Set(parsed.map((r) => r.contract)).size).toBe(WATCHED_CONTRACTS.length);
    expect(parseCot(JSON.stringify([{ contract_market_name: "X", report_date_as_yyyy_mm_dd: "" }]))).toEqual([]);
  });

  it("leaves the net null when either leg is missing", () => {
    const rows = [{ contract_market_name: "X", report_date_as_yyyy_mm_dd: "2026-07-21T00:00:00.000", lev_money_positions_long: "5" }];
    expect(parseCot(JSON.stringify(rows))[0]?.levNet).toBeNull();
  });
});

describe("scoreCot", () => {
  const base = parsed.find((r) => r.contract === "E-MINI S&P 500")!;

  it("a big weekly swing is the alert", () => {
    expect(scoreCot({ ...base, changeLevNet: BIG_NET_CHANGE })).toBe(SCORE_AUTO_ALERT);
    expect(scoreCot({ ...base, changeLevNet: -BIG_NET_CHANGE })).toBe(SCORE_AUTO_ALERT);
  });

  it("an extreme net relative to open interest posts even without a swing", () => {
    expect(scoreCot({ ...base, changeLevNet: 0, levNet: -400_000, openInterest: 1_000_000 })).toBe(SCORE_POSTABLE);
  });

  it("quiet positioning stays in the lake", () => {
    expect(scoreCot({ ...base, changeLevNet: 10, levNet: 1_000, openInterest: 1_000_000 })).toBe(SCORE_LOG_ONLY);
  });

  it("unquantified rows are never postable", () => {
    expect(scoreCot({ ...base, levNet: null })).toBe(SCORE_LOG_ONLY);
    expect(scoreCot({ ...base, openInterest: 0 })).toBe(SCORE_LOG_ONLY);
  });
});

describe("draftCot", () => {
  it("states the side, the size and the week, with no interpretation", () => {
    const row: CotRow = {
      contract: "E-MINI S&P 500",
      market: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE",
      reportDate: "2026-07-21",
      openInterest: 1_969_636,
      levLong: 134_932,
      levShort: 496_807,
      changeLevLong: -15_624,
      changeLevShort: -14_218,
      levNet: -361_875,
      changeLevNet: -1_406,
    };
    const d = draftCot(row);
    expect(d).toBe(
      "CFTC positioning: leveraged funds net short 361,875 E-MINI S&P 500 contracts, down 1,406 on the week, week ending 2026-07-21",
    );
    expect(d).not.toContain("—");
    // Never a claim about why, and never a forecast.
    expect(d.toLowerCase()).not.toMatch(/because|expect|signal|bullish|bearish/);
  });
});

describe("POSITIONING archetype", () => {
  it("renders fact + attribution and survives the register guard", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const r = renderPost(
      ARCHETYPES.POSITIONING,
      {
        factLine: "CFTC positioning: leveraged funds net short 361,875 E-MINI S&P 500 contracts, week ending 2026-07-21",
        contract: "E-MINI S&P 500",
        levNet: -361_875,
        reportDate: "2026-07-21",
        openInterest: 1_969_636,
        changeLevNet: -1_406,
      },
      { seed: "cot:1" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per CFTC");
    // "net short" contains "short", a banned advice token in isolation —
    // confirm the real rendered post still passes the publish-time guard.
    expect(checkRegister(r.text, "POSITIONING")).toEqual([]);
  });
});

describe("pollCftc end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const HOST = "https://publicreporting.cftc.gov";
  const u = new URL(cotUrl());

  it("ingests ONLY the newest report week", async () => {
    fetchMock.get(HOST).intercept({ path: u.pathname + u.search }).reply(200, FIXTURE);
    await pollCftc(env, NOW, newTickBudget(30));

    const weeks = await env.DB.prepare(
      "SELECT DISTINCT substr(event_at,1,10) AS d FROM items WHERE source = ?1",
    )
      .bind(SOURCE)
      .all<{ d: string }>();
    // The API returns history; reposting last month's positioning as news
    // would be stale-data-as-current.
    expect(weeks.results.length).toBe(1);
    const newest = Math.max(...parsed.map((r) => Date.parse(r.reportDate)));
    expect(Date.parse(weeks.results[0]!.d)).toBe(newest);

    // Net positions are recorded so "most net short we have recorded" becomes
    // answerable once the observed window supports it.
    const facts = await env.DB.prepare("SELECT metric FROM lookback_facts WHERE source = ?1 LIMIT 1")
      .bind(SOURCE)
      .first<{ metric: string }>();
    expect(facts?.metric).toBe("lev_money_net");
  });
});
