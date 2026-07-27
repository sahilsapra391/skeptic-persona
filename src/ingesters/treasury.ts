import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { recordFacts } from "../lookback";
import { enqueueForApproval } from "../pipeline/enqueue";
import { fmtUsd } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// US Treasury auction results (TreasuryDirect TA_WS). Live-verified
// 2026-07-27T22:42Z: 200, 17,934 bytes, 5 auctions, results posted the same
// day they were held.
//
// Highest numbers-per-byte source in the roadmap: no HTML, no auth, no WAF,
// and ~90 typed fields per auction. Every figure a post could cite is a named
// JSON field, which is exactly the shape the template engine's no-prose rule
// wants.
export const TREASURY_AUCTIONS =
  "https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&pagesize=40";
export const TREASURY_PAGE = "https://www.treasurydirect.gov/auctions/announcements-data-results/";

export const SOURCE = "treasury_auction";

/**
 * Bid-to-cover thresholds. These are EDITORIAL (they decide what is worth the
 * owner's attention), never arithmetic — every number in a post is the
 * Treasury's own field.
 *
 * A weak auction is the newsworthy one: demand shortfalls move the curve.
 * 2.0 is a broadly weak cover for coupons; 2.5+ is unremarkable.
 */
export const WEAK_COVER = 2.1;
export const STRONG_COVER = 3.0;

/** Terms worth posting at all. Bills price off the front end and print daily. */
export const NOTABLE_TYPES = new Set(["Note", "Bond", "TIPS", "FRN"]);

export interface TreasuryAuction {
  cusip: string;
  securityType: string; // Note | Bond | Bill | TIPS | FRN
  securityTerm: string; // "2-Year", "13-Week"
  auctionDate: string; // ISO date
  issueDate: string | null;
  offeringAmount: number | null;
  highYield: number | null;
  bidToCoverRatio: number | null;
  allocationPercentage: number | null;
  competitiveTendered: number | null;
  competitiveAccepted: number | null;
  indirectBidderAccepted: number | null;
  directBidderAccepted: number | null;
  primaryDealerAccepted: number | null;
  interestRate: number | null;
  pricePer100: number | null;
  /** Indirect share of competitive accepted — foreign/institutional demand. */
  indirectPct: number | null;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** TreasuryDirect serves "2026-07-27T00:00:00" with no zone marker. It is a
 *  calendar date, so take the date part rather than inventing a timezone. */
export function auctionDateToIso(v: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "").trim());
  return m ? (m[1] ?? null) : null;
}

export function parseAuctions(body: string): TreasuryAuction[] {
  const rows = JSON.parse(body) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  const out: TreasuryAuction[] = [];
  for (const r of rows) {
    const cusip = String(r.cusip ?? "").trim();
    const auctionDate = auctionDateToIso(r.auctionDate);
    if (!cusip || !auctionDate) continue;

    const competitiveAccepted = num(r.competitiveAccepted);
    const indirectBidderAccepted = num(r.indirectBidderAccepted);
    // Derived from two parsed fields and nothing else; null when either is
    // absent, so a post can never imply a share we did not compute.
    const indirectPct =
      competitiveAccepted !== null && indirectBidderAccepted !== null && competitiveAccepted > 0
        ? Math.round((indirectBidderAccepted / competitiveAccepted) * 1000) / 10
        : null;

    out.push({
      cusip,
      securityType: String(r.securityType ?? "").trim(),
      securityTerm: String(r.securityTerm ?? "").trim(),
      auctionDate,
      issueDate: auctionDateToIso(r.issueDate),
      offeringAmount: num(r.offeringAmount),
      highYield: num(r.highYield),
      bidToCoverRatio: num(r.bidToCoverRatio),
      allocationPercentage: num(r.allocationPercentage),
      competitiveTendered: num(r.competitiveTendered),
      competitiveAccepted,
      indirectBidderAccepted,
      directBidderAccepted: num(r.directBidderAccepted),
      primaryDealerAccepted: num(r.primaryDealerAccepted),
      interestRate: num(r.interestRate),
      pricePer100: num(r.pricePer100),
      indirectPct,
    });
  }
  return out;
}

export function scoreAuction(a: TreasuryAuction): number {
  // A result we cannot quantify is never postable: the whole product here is
  // the numbers.
  if (a.bidToCoverRatio === null || a.highYield === null) return SCORE_LOG_ONLY;
  // Bills print several times a week and rarely carry a story.
  if (!NOTABLE_TYPES.has(a.securityType)) return SCORE_LOG_ONLY;
  if (a.bidToCoverRatio <= WEAK_COVER) return SCORE_AUTO_ALERT;
  if (a.bidToCoverRatio >= STRONG_COVER) return SCORE_POSTABLE;
  return SCORE_POSTABLE;
}

/**
 * Tier A fact line. Every figure is a TreasuryDirect field.
 *
 * DELIBERATELY ABSENT: the auction "tail" (high yield minus the when-issued
 * yield at the bid deadline). WI is dealer/vendor data we cannot license, so
 * computing or implying a tail from these fields alone would be fabrication
 * wearing the clothes of arithmetic.
 */
export function draftAuction(a: TreasuryAuction): string {
  const parts: string[] = [];
  if (a.highYield !== null) parts.push(`high yield ${a.highYield}%`);
  if (a.bidToCoverRatio !== null) parts.push(`bid-to-cover ${a.bidToCoverRatio}`);
  if (a.offeringAmount !== null) parts.push(`${fmtUsd(a.offeringAmount)} offered`);
  const tail = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  return `US Treasury ${a.securityTerm} ${a.securityType} auction ${a.auctionDate}${tail}`;
}

export async function pollTreasury(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, SOURCE);
  try {
    const res = await politeFetch(TREASURY_AUCTIONS, {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
    });
    if (!res.ok) throw new Error(`treasury ${res.status}`);
    const auctions = parseAuctions(res.body);
    if (auctions.length === 0) throw new Error("parsed to zero auctions");

    let inserted = 0;
    for (const a of auctions) {
      const score = scoreAuction(a);
      // Results are published the same day; anything older is history we hold
      // for the lookback, not news to post.
      const fresh = a.auctionDate >= now.toISOString().slice(0, 10);
      const result = await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: `${a.cusip}:${a.auctionDate}`,
          category: "auction",
          eventAt: `${a.auctionDate}T00:00:00.000Z`,
          sourceUrl: TREASURY_PAGE,
          payload: { ...a, factLine: draftAuction(a) },
          score,
          status: score >= SCORE_POSTABLE && fresh ? "new" : "logged",
        },
        now,
      );
      if (result.outcome !== "inserted" || result.id === null) continue;
      inserted += 1;

      // Facts for the lookback: bid-to-cover per term is the series that makes
      // "weakest 2-Year cover since {date}" answerable, once the observed
      // window is long enough to say it.
      if (a.bidToCoverRatio !== null) {
        await recordFacts(
          env.DB,
          [
            {
              itemId: result.id,
              source: SOURCE,
              entity: `${a.securityTerm} ${a.securityType}`,
              metric: "bid_to_cover",
              value: a.bidToCoverRatio,
              occurredAt: `${a.auctionDate}T00:00:00.000Z`,
            },
          ],
          now,
        );
      }
    }

    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    if (inserted > 0) log("info", "treasury auctions ingested", { inserted });
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    log("error", "treasury poll failed", { error: String(e), failures: state.consecutiveFailures });
    return;
  }

  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 3`,
  )
    .bind(SOURCE, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "TREASURY_AUCTION", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
