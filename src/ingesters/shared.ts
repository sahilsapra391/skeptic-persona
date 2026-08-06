/**
 * Stale-at-ingest cutoff shared by all ingesters. A wire is only worth
 * notifying about while it is news: anything older than this at FIRST SIGHT
 * (first-deploy backfill, outage recovery, overflow catch-ups) goes to the
 * data lake as 'logged' instead of spamming the approval queue.
 */
export const STALE_AT_INGEST_HOURS = 24;

export function isFreshAtIngest(eventIso: string, now: Date): boolean {
  if (!eventIso) return false; // no parsed timestamp -> can't claim freshness
  const age = now.getTime() - new Date(eventIso).getTime();
  return age <= STALE_AT_INGEST_HOURS * 3_600_000;
}

/**
 * Freshness for DATE-ONLY sources (congressional filings carry no
 * time-of-day). Anchoring a date at UTC midnight and applying the 24h gate
 * would expire filings at ~20:00 ET of their own filing day — evening
 * disclosures would silently self-suppress. Date-only precision gets a
 * whole-day allowance instead: fresh through 48h after the UTC-midnight
 * anchor (i.e. the filing date and the day after).
 */
export function isFreshDateOnly(dateOnlyIso: string, now: Date): boolean {
  if (!dateOnlyIso) return false;
  const age = now.getTime() - new Date(dateOnlyIso).getTime();
  return age <= 2 * STALE_AT_INGEST_HOURS * 3_600_000;
}

/**
 * Compact money, pipeline-wide copy law (owner ruling 2026-08-06).
 *
 *   Divide to the largest unit >= 1, round to AT MOST 2 decimals, strip
 *   trailing zeros. Under $1K renders in full dollars.
 *   $115M (not $115.00M), $2.65B, $4.66T, $617K, $950.
 *
 * THE OUTPUT OF THIS FUNCTION IS THE ONLY LICENSED RENDERING of a figure. It
 * is pre-computed into payload display fields (value_display, delta_display,
 * pct_display) and the model uses those VERBATIM. A model-side re-rounding —
 * "$2.6B" where the payload says "$2.65B" — is refused with the same force as
 * an unlicensed number, because it is one: a figure the payload never stated.
 *
 * Full precision stays in the payload and the ledger. This is display only,
 * and it never becomes the stored value.
 */
const MONEY_UNITS = [
  [1_000_000_000_000, "T"],
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "K"],
] as const;

/**
 * UNIFORM 2 DECIMALS, all scales (owner ruling 2026-08-06, superseding the
 * significant-figure reading).
 *
 *   Divide to the largest unit >= 1, round to at most 2 decimals, strip
 *   trailing zeros. NOT significant figures.
 *
 * I derived a 4-sig-fig rule from the ruling's examples, because it was the
 * only rule that reproduced all of them including "$192.7B" and "+204%". The
 * owner has since ruled uniform 2dp explicitly, which renders those two as
 * "$192.73B" and "+203.99%". Recorded because the earlier derivation was
 * reasonable and is now WRONG, and a future reader finding "$192.7B" in an old
 * draft should know which rule produced it.
 *
 * The output of this function is the ONLY licensed rendering of a figure. It
 * is pre-computed into payload display fields and the model uses them
 * verbatim; a re-rounded "$2.6B" for "$2.65B" is refused as the unlicensed
 * number it is. Full precision stays in the payload and the ledger.
 */
export function trimNum(n: number, maxDp = 2): string {
  if (!Number.isFinite(n)) return "0";
  return String(Number(n.toFixed(maxDp)));
}

export function fmtUsd(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  const body = (() => {
    for (const [size, suffix] of MONEY_UNITS) {
      if (abs >= size) return `${trimNum(abs / size)}${suffix}`;
    }
    // Under $1K is stated in full dollars: compacting it would lose more
    // precision than it saves characters.
    return trimNum(abs, 0);
  })();
  return `${neg ? "-" : ""}$${body}`;
}

/** Percentages, same convention: +204%, -95.13%, at most 2 decimals, zeros
 *  stripped. The sign is explicit because a delta without one reads as a
 *  level. */
export function fmtPct(n: number, opts: { signed?: boolean } = {}): string {
  const signed = opts.signed ?? true;
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${trimNum(n)}%`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Days between a filing date and a transaction date, both date-only.
 * Lives here because BOTH chambers need it and the disclosure lag is the
 * editorial point of a PTR post — two implementations would eventually
 * disagree about how late a trade was reported.
 */
/**
 * MM/DD/YYYY (date-only, as both chambers serve it) -> ISO at UTC midnight.
 *
 * Digits are NOT zero-padded by either source: the House bulk index serves
 * "2/11/2026" and "7/8/2026" today. This is the ONE date parser for
 * congressional filings; efdDateToIso and houseDateToIso delegate here.
 * A stricter copy of this regex silently returned null and dropped the whole
 * disclosure-lag clause, which is a parsed fact going unstated.
 */
export function mdyToIso(mdY: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdY.trim());
  if (!m) return "";
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}T00:00:00.000Z`;
}

export function lagDays(filedIso: string, txnDate: string): number | null {
  const txnIso = mdyToIso(txnDate);
  if (!filedIso || !txnIso) return null;
  const diff = new Date(filedIso).getTime() - new Date(txnIso).getTime();
  if (!Number.isFinite(diff)) return null;
  const days = Math.round(diff / 86_400_000);
  // A disclosure cannot precede its own trade. A future-dated transaction
  // (typo, pre-report) must not print "disclosed -4 days after the latest
  // trade", and must not win the "newest" slot that drives tradeDate,
  // amountBand and the band-width beats. This clamp was lost when the
  // function moved here from senatePtr; form4.ts still enforces it.
  return days >= 0 ? days : null;
}

/**
 * Whole weeks in a disclosure lag, floored. 45 days -> 6 weeks.
 *
 * WHY THIS IS A FIELD AND NOT THE MODEL'S JOB. The owner's flagship
 * CONGRESS_PTR exemplar reads "Legal, disclosed, and six weeks stale." The
 * fabrication gate refuses arithmetic on principle -- a model that computes
 * is a model that can compute wrongly and confidently -- so the only way that
 * sentence can ever be written is if 6 is a number the payload states.
 *
 * The prompt has been telling the model "derived figures are already computed
 * as fields" since p4-01. This is the first one that actually is.
 */
export function lagWeeks(days: number | null): number | null {
  if (days === null || !Number.isFinite(days) || days < 0) return null;
  return Math.floor(days / 7);
}

/**
 * The OLDEST trade's lag in a multi-transaction filing.
 *
 * `lagDays` is the newest trade's lag, which is the honest answer to "how
 * late was this filing" and the wrong one for "how much history landed at
 * once". A House PTR clearing eleven trades spanning March to May discloses
 * its newest trade four days late and its oldest 118 days late; only the
 * second number describes what the filing actually is.
 *
 * Returns null when no transaction carries a usable date, and equals
 * `lagDays` on a single-transaction filing rather than being suppressed --
 * whether "up to" is worth saying is the template's call, not this one's.
 */
export function maxLagDays(filedIso: string, txns: readonly { transactionDate: string }[]): number | null {
  const lags = txns.map((t) => lagDays(filedIso, t.transactionDate)).filter((d): d is number => d !== null);
  return lags.length > 0 ? Math.max(...lags) : null;
}

/**
 * Ratio between a band's upper and lower bound ("$1,001 - $15,000" -> ~15).
 * Gates the "The range is doing a lot of work." escalation beat: a wide band
 * is a parsed property of the disclosure, not an inference about the trade.
 */
export function bandWidth(band: string): number | null {
  const nums = band.match(/[\d,]+/g);
  if (!nums || nums.length < 2) return null;
  const lo = Number(nums[0]!.replace(/,/g, ""));
  const hi = Number(nums[nums.length - 1]!.replace(/,/g, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return hi - lo;
}

export function bandSpan(band: string): number | null {
  const nums = band.match(/[\d,]+/g);
  if (!nums || nums.length < 2) return null;
  const lo = Number(nums[0]!.replace(/,/g, ""));
  const hi = Number(nums[nums.length - 1]!.replace(/,/g, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return null;
  return Math.round((hi / lo) * 10) / 10;
}

/**
 * "$NET". The cashtag form for a stock symbol (owner instruction 2026-08-06:
 * every ticker in generated copy carries the $ prefix).
 *
 * ONLY EVER CALLED ON A REAL TICKER. Several draft builders resolve a symbol
 * as `ticker ?? issuerName`, so the value reaching the line may be a company
 * or asset name, and "$Cloudflare, Inc." would print a symbol that does not
 * exist. Callers branch on the ticker itself rather than passing the resolved
 * fallback through here, and Form 144 is deliberately excluded because it
 * parses no symbol at all.
 *
 * The validator was already built for this shape: entityCheck matches
 * /\$([A-Z]{1,5})\b/ and checks the captured symbol against the payload
 * case-sensitively, so a $ ticker is the form it expects and an invented one
 * is still refused.
 */
export function tickerTag(ticker: string): string {
  return `$${ticker}`;
}
