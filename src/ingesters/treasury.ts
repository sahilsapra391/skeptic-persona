import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE ,
  recordSourceError,
} from "../lib/db";
import { recordFacts } from "../lookback";
import { enqueueForApproval } from "../pipeline/enqueue";
import { fmtUsd } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// US Treasury auction results, via the Fiscal Data API.
//
// HOST CHANGE 2026-07-28. The original endpoint, treasurydirect.gov/TA_WS,
// works from a residential connection but returns **HTTP 525** from
// Cloudflare Worker egress — a TLS handshake failure between Cloudflare and
// that origin. Six consecutive production polls failed with:
//   treasury 525 type=text/plain body=error code: 525
// Not a bot block and not a code bug: the handshake never completes, so no
// amount of header tuning would help. api.fiscaldata.treasury.gov is the
// same issuer's modern API gateway carrying the same auction results.
//
// Still the highest numbers-per-byte source available: no auth, no HTML, and
// every citable figure is a named JSON field.
// page[size]=12, not 40. VERIFIED CAUSE of the follow-on failure: at 40 the
// response is ~147 KB and the Worker request timed out
// ("TimeoutError: The operation was aborted due to timeout", 10 consecutive
// polls). Twelve rows is ~45 KB and still covers several days of auctions on
// a job that runs every 30 minutes, so nothing is missed.
export const TREASURY_AUCTIONS =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query" +
  "?sort=-auction_date&page%5Bsize%5D=12";
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
  // Fiscal Data serves absent values as the STRING "null", not JSON null.
  // Treating that as a number would print NaN, or worse, coerce to 0.
  if (s === "" || s.toLowerCase() === "null") return null;
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
  const doc = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
  const rows = doc.data;
  if (!Array.isArray(rows)) return [];
  const out: TreasuryAuction[] = [];
  for (const r of rows) {
    const cusip = String(r.cusip ?? "").trim();
    const auctionDate = auctionDateToIso(r.auction_date);
    if (!cusip || !auctionDate) continue;

    const competitiveAccepted = num(r.comp_accepted);
    const indirectBidderAccepted = num(r.indirect_bidder_accepted);
    // Derived from two parsed fields and nothing else; null when either is
    // absent, so a post can never imply a share we did not compute.
    const indirectPct =
      competitiveAccepted !== null && indirectBidderAccepted !== null && competitiveAccepted > 0
        ? Math.round((indirectBidderAccepted / competitiveAccepted) * 1000) / 10
        : null;

    out.push({
      cusip,
      securityType: String(r.security_type ?? "").trim(),
      securityTerm: String(r.security_term ?? "").trim(),
      auctionDate,
      issueDate: auctionDateToIso(r.issue_date),
      offeringAmount: num(r.offering_amt),
      highYield: num(r.high_yield),
      bidToCoverRatio: num(r.bid_to_cover_ratio),
      allocationPercentage: num(r.allocation_pctage),
      competitiveTendered: num(r.comp_tendered),
      competitiveAccepted,
      indirectBidderAccepted,
      directBidderAccepted: num(r.direct_bidder_accepted),
      primaryDealerAccepted: num(r.primary_dealer_accepted),
      interestRate: num(r.int_rate),
      pricePer100: num(r.price_per100),
      indirectPct,
    });
  }
  return out;
}

export function scoreAuction(a: TreasuryAuction): number {
  // A result we cannot quantify is never postable: the whole product here is
  // the numbers. NOTE bid-to-cover only — bills price on a discount rate and
  // carry high_yield = null, and an ANNOUNCED auction has null results until
  // it is held, which is how future-dated rows exclude themselves.
  if (a.bidToCoverRatio === null) return SCORE_LOG_ONLY;
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
      // 30s: this origin is measurably slower from Worker egress than from a
      // residential connection, where the same request completes in 0.7s.
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      // Self-explaining failure: three polls failed in production with no way
      // to tell a block from a shape change. Carry enough context to decide.
      throw new Error(
        `treasury ${res.status} type=${res.contentType ?? "?"} body=${res.body.slice(0, 120)}`,
      );
    }
    let auctions: TreasuryAuction[];
    try {
      auctions = parseAuctions(res.body);
    } catch (parseErr) {
      throw new Error(
        `treasury body did not parse (${String(parseErr)}) type=${res.contentType ?? "?"} ` +
          `bytes=${res.body.length} prefix=${JSON.stringify(res.body.slice(0, 80))}`,
      );
    }
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
    await recordSourceError(env.DB, SOURCE, e, now);
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
