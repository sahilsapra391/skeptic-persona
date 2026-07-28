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
const parsed = parseAuctions(FIXTURE);

describe("parseAuctions (live fixture)", () => {
  const parsed = parseAuctions(FIXTURE);

  it("parses the verified 13-Week Bill exactly", () => {
    const a = parsed.find((x) => x.cusip === "912797SK4")!;
    expect(a).toMatchObject({
      securityType: "Bill",
      securityTerm: "13-Week",
      auctionDate: "2026-07-27",
      offeringAmount: 92_000_000_000,
      bidToCoverRatio: 3.06,
      allocationPercentage: 83.44,
      competitiveTendered: 279_572_250_000,
      competitiveAccepted: 89_790_841_100,
      pricePer100: 99.035653,
    });
    // Bills price on a discount rate, so high_yield really is absent.
    expect(a.highYield).toBeNull();
  });

  it('treats the STRING "null" as absent, never as a number', () => {
    // Fiscal Data serves absent values as the literal string "null".
    // Coercing that would print NaN, or silently become 0.
    const a = parsed.find((x) => x.highYield === null)!;
    expect(a).toBeTruthy();
    expect(Number.isNaN(a.highYield as unknown as number)).toBe(false);
  });

  it("computes the indirect share from two parsed fields only", () => {
    const a = parsed.find((x) => x.cusip === "912797SK4")!;
    // 60,072,626,100 / 89,790,841,100 = 66.9%
    expect(a.indirectPct).toBeCloseTo(66.9, 1);
  });

  it("leaves the indirect share null when either input is missing", () => {
    const doc = JSON.parse(FIXTURE) as { data: Array<Record<string, unknown>> };
    doc.data[0]!.indirect_bidder_accepted = "null";
    expect(parseAuctions(JSON.stringify(doc))[0]?.indirectPct).toBeNull();
  });

  it("carries every auction in the page and skips rows with no cusip or date", () => {
    expect(parsed.length).toBeGreaterThan(0);
    expect(parseAuctions(JSON.stringify({ data: [{ cusip: "", auction_date: "2026-07-27" }] }))).toEqual([]);
    expect(parseAuctions(JSON.stringify({ data: [{ cusip: "X", auction_date: "" }] }))).toEqual([]);
    // A non-envelope body is not a silent empty page.
    expect(parseAuctions(JSON.stringify({}))).toEqual([]);
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
  const base = parseAuctions(FIXTURE).find((a) => a.securityType === "Note") ?? parseAuctions(FIXTURE)[0]!;

  it("an unquantified result is never postable", () => {
    expect(scoreAuction({ ...base, bidToCoverRatio: null })).toBe(SCORE_LOG_ONLY);
    // An ANNOUNCED but unheld auction has null results, which is how
    // future-dated rows exclude themselves.
    expect(scoreAuction({ ...base, bidToCoverRatio: null, highYield: null })).toBe(SCORE_LOG_ONLY);
  });

  it("a coupon with no high yield still grades on bid-to-cover", () => {
    // Requiring high_yield would drop every bill and every coupon on
    // announcement day.
    expect(scoreAuction({ ...base, securityType: "Note", highYield: null, bidToCoverRatio: 2.5 })).toBeGreaterThanOrEqual(
      SCORE_POSTABLE,
    );
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
    const a = parseAuctions(FIXTURE).find((x) => x.cusip === "912797SK4")!;
    const d = draftAuction(a);
    expect(d).toBe("US Treasury 13-Week Bill auction 2026-07-27: bid-to-cover 3.06, $92.0B offered");
    expect(d).not.toContain("—");
    // A tail needs when-issued yield, which is vendor data we cannot license.
    expect(d.toLowerCase()).not.toContain("tail");
  });

  it("omits what did not parse", () => {
    const a = parseAuctions(FIXTURE).find((x) => x.cusip === "912797SK4")!;
    const d = draftAuction({ ...a, highYield: null, bidToCoverRatio: null, offeringAmount: null });
    expect(d).toBe("US Treasury 13-Week Bill auction 2026-07-27");
  });
});

describe("TREASURY_AUCTION archetype", () => {
  const payload = { ...parseAuctions(FIXTURE).find((a) => a.cusip === "912797SK4")!, factLine: "x" } as Record<string, unknown>;

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

  const TD = "https://api.fiscaldata.treasury.gov";
  const PATH = TREASURY_AUCTIONS.replace(TD, "");

  it("ingests, grades, records bid-to-cover facts, and dedups on re-poll", async () => {
    fetchMock.get(TD).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollTreasury(env, NOW, newTickBudget(30));

    const rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1").bind(SOURCE).all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(parsed.length);
    // Bills logged, coupons queued.
    expect(rows.results.filter((r) => r.status === "logged").length).toBeGreaterThan(0);

    const facts = await env.DB.prepare(
      "SELECT entity, metric, value FROM lookback_facts WHERE source = ?1 ORDER BY value",
    )
      .bind(SOURCE)
      .all<{ entity: string; metric: string; value: number }>();
    expect(facts.results.length).toBeGreaterThan(0);
    expect(facts.results.every((f) => f.metric === "bid_to_cover")).toBe(true);
    expect(facts.results.some((f) => f.entity.includes("Bill") || f.entity.includes("Note"))).toBe(true);

    fetchMock.get(TD).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollTreasury(env, NOW, newTickBudget(30));
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(SOURCE).first<{ n: number }>();
    expect(after?.n).toBe(parsed.length); // dedup on (cusip, auctionDate)
  });

  it("a failing endpoint counts a failure and ingests nothing", async () => {
    await env.DB.prepare("DELETE FROM lookback_facts WHERE source = ?1").bind(SOURCE).run();
    fetchMock.get(TD).intercept({ path: PATH }).reply(500, "err");
    await pollTreasury(env, NOW, newTickBudget(30));
    const state = await env.DB.prepare("SELECT consecutive_failures AS f FROM source_state WHERE source = ?1").bind(SOURCE).first<{ f: number }>();
    expect(state?.f).toBe(1);
  });
});
