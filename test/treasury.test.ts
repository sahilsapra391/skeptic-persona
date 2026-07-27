import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FIXTURE from "./fixtures/treasury-auctions.json?raw";
import {
  auctionDateToIso,
  draftAuction,
  parseAuctions,
  pollTreasury,
  scoreAuction,
  SOURCE,
  TREASURY_AUCTIONS,
  type TreasuryAuction,
} from "../src/ingesters/treasury";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixture captured 2026-07-27T22:42Z. THIS is the parse contract.
const NOW = new Date("2026-07-27T23:00:00Z");

describe("parseAuctions (live fixture)", () => {
  const parsed = parseAuctions(FIXTURE);

  it("parses the 2-Year Note with exact verified fields", () => {
    const a = parsed.find((x) => x.cusip === "91282CRB9")!;
    expect(a).toMatchObject({
      securityType: "Note",
      securityTerm: "2-Year",
      auctionDate: "2026-07-27",
      offeringAmount: 69_000_000_000,
      highYield: 4.315,
      bidToCoverRatio: 2.66,
      allocationPercentage: 69.04,
      competitiveTendered: 182_453_432_000,
      competitiveAccepted: 67_776_042_400,
      interestRate: 4.25,
      pricePer100: 99.87672,
    });
  });

  it("computes the indirect share from two parsed fields only", () => {
    const a = parsed.find((x) => x.cusip === "91282CRB9")!;
    // 38,355,032,000 / 67,776,042,400 = 56.6%
    expect(a.indirectPct).toBeCloseTo(56.6, 1);
  });

  it("leaves the indirect share null when either input is missing", () => {
    const rows = JSON.parse(FIXTURE) as Array<Record<string, unknown>>;
    rows[0]!.indirectBidderAccepted = "";
    expect(parseAuctions(JSON.stringify(rows))[0]?.indirectPct).toBeNull();
  });

  it("carries every auction in the page and skips rows with no cusip or date", () => {
    expect(parsed.length).toBe(5);
    expect(parseAuctions(JSON.stringify([{ cusip: "", auctionDate: "2026-07-27T00:00:00" }]))).toEqual([]);
    expect(parseAuctions(JSON.stringify([{ cusip: "X", auctionDate: "" }]))).toEqual([]);
  });
});

describe("auctionDateToIso", () => {
  it("takes the calendar date rather than inventing a timezone", () => {
    // TreasuryDirect serves a zone-less stamp; treating it as UTC midnight and
    // re-rendering could shift the date for readers behind UTC.
    expect(auctionDateToIso("2026-07-27T00:00:00")).toBe("2026-07-27");
    expect(auctionDateToIso("")).toBeNull();
    expect(auctionDateToIso(null)).toBeNull();
  });
});

describe("scoreAuction", () => {
  const base = parseAuctions(FIXTURE).find((a) => a.cusip === "91282CRB9")!;

  it("an unquantified result is never postable", () => {
    expect(scoreAuction({ ...base, bidToCoverRatio: null })).toBe(SCORE_LOG_ONLY);
    expect(scoreAuction({ ...base, highYield: null })).toBe(SCORE_LOG_ONLY);
  });

  it("bills are lake-only; coupons carry the story", () => {
    const bill = parseAuctions(FIXTURE).find((a) => a.securityType === "Bill")!;
    expect(scoreAuction(bill)).toBe(SCORE_LOG_ONLY);
    expect(scoreAuction(base)).toBeGreaterThanOrEqual(SCORE_POSTABLE);
  });

  it("a weak cover is the alert, not a strong one", () => {
    expect(scoreAuction({ ...base, bidToCoverRatio: 2.0 })).toBe(SCORE_AUTO_ALERT);
    expect(scoreAuction({ ...base, bidToCoverRatio: 3.5 })).toBe(SCORE_POSTABLE);
  });
});

describe("draftAuction", () => {
  it("states only Treasury's own fields and never implies a tail", () => {
    const a = parseAuctions(FIXTURE).find((x) => x.cusip === "91282CRB9")!;
    const d = draftAuction(a);
    expect(d).toBe(
      "US Treasury 2-Year Note auction 2026-07-27: high yield 4.315%, bid-to-cover 2.66, $69.0B offered",
    );
    expect(d).not.toContain("—");
    // A tail needs when-issued yield, which is vendor data we cannot license.
    expect(d.toLowerCase()).not.toContain("tail");
  });

  it("omits what did not parse", () => {
    const a = parseAuctions(FIXTURE)[0]!;
    const d = draftAuction({ ...a, highYield: null, bidToCoverRatio: null, offeringAmount: null });
    expect(d).toBe("US Treasury 2-Year Note auction 2026-07-27");
  });
});

describe("TREASURY_AUCTION archetype", () => {
  const payload = { ...parseAuctions(FIXTURE).find((a) => a.cusip === "91282CRB9")!, factLine: "x" } as Record<string, unknown>;

  it("renders fact + attribution + a gated beat", () => {
    const r = renderPost(ARCHETYPES.TREASURY_AUCTION, { ...payload, factLine: draftAuction(parseAuctions(FIXTURE)[0]!) }, { seed: "t:1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per US Treasury");
    expect(r.text).not.toContain("—");
  });

  it("the weak-cover beat fires only on a weak cover", () => {
    const strong = pickBeat(ARCHETYPES.TREASURY_AUCTION, { ...payload, bidToCoverRatio: 3.2 }, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(strong?.beat.id).not.toBe("auction.weakCover");
    const weak = pickBeat(ARCHETYPES.TREASURY_AUCTION, { ...payload, bidToCoverRatio: 2.0 }, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(weak?.beat.id).toBe("auction.weakCover");
  });

  it("the indirect beat cannot render without the computed share", () => {
    const picked = pickBeat(
      ARCHETYPES.TREASURY_AUCTION,
      { ...payload, indirectPct: null },
      { recentSkeletons: [], recentBeats: ["auction.allocation", "auction.coverIsDemand"] },
      0,
    );
    expect(picked?.beat.id).not.toBe("auction.indirect");
  });
});

describe("pollTreasury end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const TD = "https://www.treasurydirect.gov";
  const PATH = TREASURY_AUCTIONS.replace(TD, "");

  it("ingests, grades, records bid-to-cover facts, and dedups on re-poll", async () => {
    fetchMock.get(TD).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollTreasury(env, NOW, newTickBudget(30));

    const rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1").bind(SOURCE).all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(5);
    // Bills logged, coupons queued.
    expect(rows.results.filter((r) => r.status === "logged").length).toBeGreaterThan(0);

    const facts = await env.DB.prepare(
      "SELECT entity, metric, value FROM lookback_facts WHERE source = ?1 ORDER BY value",
    )
      .bind(SOURCE)
      .all<{ entity: string; metric: string; value: number }>();
    expect(facts.results.length).toBe(5);
    expect(facts.results.every((f) => f.metric === "bid_to_cover")).toBe(true);
    expect(facts.results.some((f) => f.entity === "2-Year Note")).toBe(true);

    fetchMock.get(TD).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollTreasury(env, NOW, newTickBudget(30));
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(SOURCE).first<{ n: number }>();
    expect(after?.n).toBe(5); // dedup on (cusip, auctionDate)
  });

  it("a failing endpoint counts a failure and ingests nothing", async () => {
    await env.DB.prepare("DELETE FROM lookback_facts WHERE source = ?1").bind(SOURCE).run();
    fetchMock.get(TD).intercept({ path: PATH }).reply(500, "err");
    await pollTreasury(env, NOW, newTickBudget(30));
    const state = await env.DB.prepare("SELECT consecutive_failures AS f FROM source_state WHERE source = ?1").bind(SOURCE).first<{ f: number }>();
    expect(state?.f).toBe(1);
  });
});
