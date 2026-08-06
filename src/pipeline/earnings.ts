import type { Payload } from "../templates/types";
import { tickerTag } from "../ingesters/shared";

/**
 * The earnings-event lane (p5-20), 8-K item 2.02.
 *
 * TWO RULES, and everything here is one or the other.
 *
 * 1. NO NUMBER EVER COMES OUT OF PROSE. Item 2.02 announces that results were
 *    released; the results live in Exhibit 99.1, which is a press release.
 *    Extracting EPS or revenue from it is number extraction from unstructured
 *    text, and a misread decimal in an earnings figure is the most damaging
 *    thing this desk could publish. The payload this file builds carries NO
 *    earnings figure at all, so no template can interpolate one by mistake.
 *
 * 2. A CASHTAG IS A LOOKUP, NEVER A GUESS. It resolves through the `issuers`
 *    table on CIK — the SEC's own identifier, stable across filing agents and
 *    name changes. Measured 2026-08-06: 3,189 of 3,440 stored 8-K items
 *    (92.7%) resolve; the other 7.3% render the FILED COMPANY NAME.
 *
 * Why `issuers` and not `cusip_map`: cusip_map is keyed on CUSIP because it
 * exists for 13F holdings, which is what 13F reports. An 8-K carries a CIK and
 * no CUSIP, so joining through cusip_map would need a CUSIP we do not have.
 * Same rule, right key.
 */

export interface IssuerRow {
  readonly cik: number;
  readonly name: string;
  readonly ticker: string | null;
  readonly exchange: string | null;
  readonly public_float: number | null;
}

/** `$AAPL` when the CIK resolves, the filed company name when it does not. */
export function displayNameFor(company: string, issuer: IssuerRow | null): string {
  const t = issuer?.ticker?.trim();
  return t ? tickerTag(t) : company;
}

/**
 * Market-cap tiers from `public_float`, the only size proxy we already hold.
 *
 * THE LOAD-BEARING RULE: a float can only ever RAISE salience, never gate it.
 * Measured 2026-08-06: only 4,380 of 8,056 issuers (54.4%) carry one. An
 * issuer without a float is UNMEASURED, not small, and treating unmeasured as
 * small would silently suppress real news from more than half the universe —
 * exactly the "absence we did not parse" the never-list forbids asserting.
 *
 * Thresholds are the SEC's own filer categories, not numbers invented here:
 * $700M is the large-accelerated-filer floor and $75M the accelerated-filer
 * floor (17 CFR 240.12b-2). Using the regulator's own size bands means the
 * tiering can be explained without appealing to taste.
 */
export const LARGE_ACCELERATED_FLOOR = 700_000_000;
export const ACCELERATED_FLOOR = 75_000_000;

export type SizeTier = "large" | "accelerated" | "small" | "unmeasured";

export function sizeTier(publicFloat: number | null): SizeTier {
  if (publicFloat === null || !Number.isFinite(publicFloat) || publicFloat <= 0) return "unmeasured";
  if (publicFloat >= LARGE_ACCELERATED_FLOOR) return "large";
  if (publicFloat >= ACCELERATED_FLOOR) return "accelerated";
  return "small";
}

/** Salience bump per tier. `unmeasured` adds nothing and subtracts nothing. */
export function sizeBump(tier: SizeTier): number {
  switch (tier) {
    case "large":
      return 15;
    case "accelerated":
      return 8;
    case "small":
      return 0;
    case "unmeasured":
      return 0;
  }
}

/**
 * The period the results cover, and ONLY when the SEC states it structurally.
 *
 * EDGAR's submission metadata carries a `period` for many 8-Ks. When it is
 * absent the card simply omits the period rather than inferring one from the
 * filing date — a Q-label guessed from a timestamp would be a claim about
 * which quarter a company reported, which is exactly the kind of small
 * confident wrongness that costs a wire its credibility.
 */
export function periodLabel(periodIso: string | null | undefined): string | null {
  if (!periodIso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodIso.slice(0, 10));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  // A period END of Mar/Jun/Sep/Dec is a calendar quarter end. Anything else
  // is a non-standard fiscal close, and rather than guess a fiscal quarter we
  // state the month it ended.
  const q = { 3: "Q1", 6: "Q2", 9: "Q3", 12: "Q4" }[month];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return q ? `${q} ${year}` : `the period ended ${MONTHS[month - 1]} ${year}`;
}

export interface EarningsPayloadInput {
  readonly company: string;
  readonly cik: string;
  readonly formType: string;
  readonly filedIso: string;
  readonly periodIso?: string | null;
  readonly issuer: IssuerRow | null;
  /** Carried through from the 8-K lookback, when present. */
  readonly sameItemOccurrence?: number;
  readonly priorSameItemThisYear?: number;
  readonly lookbackCoverageDays?: number;
}

export function buildEarningsPayload(input: EarningsPayloadInput): Payload {
  const tier = sizeTier(input.issuer?.public_float ?? null);
  const payload: Payload = {
    company: input.company,
    cik: input.cik,
    formType: input.formType,
    filedIso: input.filedIso,
    displayName: displayNameFor(input.company, input.issuer),
    tickerResolved: Boolean(input.issuer?.ticker),
    exchange: input.issuer?.exchange ?? null,
    sizeTier: tier,
    // The float itself rides in the payload for the ledger, but there is NO
    // display field for it: this lane never prints a company's size, it only
    // uses it to decide whether the filing is worth the owner's attention.
    publicFloat: input.issuer?.public_float ?? null,
  };
  const period = periodLabel(input.periodIso);
  if (period) payload.periodLabel = period;
  if (input.sameItemOccurrence !== undefined) payload.sameItemOccurrence = input.sameItemOccurrence;
  if (input.priorSameItemThisYear !== undefined) payload.priorSameItemThisYear = input.priorSameItemThisYear;
  if (input.lookbackCoverageDays !== undefined) payload.lookbackCoverageDays = input.lookbackCoverageDays;
  return payload;
}

/**
 * Which archetype an 8-K belongs to.
 *
 * Item 4.02 OUTRANKS 2.02 deliberately. A filing that both reports results and
 * says prior financials cannot be relied upon is a non-reliance story, and
 * carding it as a routine earnings event would bury the only part that
 * matters.
 */
export function archetypeForItems(codes: readonly string[]): "FILING_8K" | "EARNINGS_EVENT" {
  if (codes.includes("4.02")) return "FILING_8K";
  return codes.includes("2.02") ? "EARNINGS_EVENT" : "FILING_8K";
}

export async function issuerFor(db: D1Database, cik: string): Promise<IssuerRow | null> {
  const n = Number(cik);
  if (!Number.isFinite(n) || n <= 0) return null;
  return db
    .prepare(`SELECT cik, name, ticker, exchange, public_float FROM issuers WHERE cik = ?1`)
    .bind(n)
    .first<IssuerRow>();
}
