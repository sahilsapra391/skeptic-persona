import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import {
  buildBreakdownPayload,
  filingUrl,
  flattenBreakdown,
  selectableFilingsSql,
  CARDS_PER_RUN,
  FILING_FRESH_HOURS,
  type CusipMap,
  type DiffRow,
  type EnqueueableFiling,
  type HoldingRow,
} from "../pipeline/thirteenF";
import { iso } from "../lib/time";
import { log } from "../lib/log";

/**
 * The job that closes D-28: 13F filings become cards.
 *
 * The lane has filled `filings_13f`, `holdings_13f` and `diffs_13f` since it
 * went live and never once written to `items`, so 696 filings produced zero
 * cards. Everything needed to card them already existed except this: a step
 * that reads the tables, builds a payload, and enqueues.
 *
 * NO EXTERNAL FETCHES. Every row it needs is already in D1, so this job is
 * pure read-plus-write and cannot fail on egress. That is why it is safe to
 * run on a short cadence during the Aug-14 flood.
 */
const SOURCE = "edgar_13f_breakdown";

async function cusipMap(db: D1Database): Promise<CusipMap> {
  const rows = await db.prepare(`SELECT cusip, ticker FROM cusip_map`).all<{ cusip: string; ticker: string }>();
  return new Map(rows.results.map((r) => [r.cusip, r.ticker]));
}

export async function pollThirteenFCards(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);

  try {
    const since = iso(new Date(now.getTime() - FILING_FRESH_HOURS * 3_600_000));
    const due = await env.DB.prepare(selectableFilingsSql())
      .bind(since, CARDS_PER_RUN)
      .all<EnqueueableFiling>();

    let carded = 0;
    const map = await cusipMap(env.DB);

    for (const filing of due.results) {
      const holdings = await env.DB.prepare(
        `SELECT cusip, issuer, value_usd, shares, sh_prn_type, put_call, class
         FROM holdings_13f WHERE filing_id = ?1 ORDER BY value_usd DESC LIMIT 10`,
      )
        .bind(filing.id)
        .all<HoldingRow>();
      const diffs = await env.DB.prepare(
        `SELECT cusip, issuer, status, value_usd, prev_value_usd, pct_of_portfolio, qoq_share_delta_pct, put_call
         FROM diffs_13f WHERE cik = ?1 AND period = ?2`,
      )
        .bind(filing.cik, filing.period)
        .all<DiffRow>();

      // A filing with no parsed holdings cannot card. Refusing is the whole
      // discipline: an empty top-ten would render a branded card that says
      // nothing, which is worse than no card at all.
      if (holdings.results.length === 0) {
        log("warn", "13f filing has no parsed holdings; skipping", { filingId: filing.id, cik: filing.cik });
        continue;
      }

      const payload = flattenBreakdown(buildBreakdownPayload(filing, holdings.results, diffs.results, map));
      const url = filingUrl(filing.cik, filing.accession);
      const item = await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: filing.accession,
          category: "institutional",
          // The FILING date, not the period: event_at is when the record
          // became public, and the period is what it reports on.
          eventAt: filing.filed_at,
          sourceUrl: url,
          payload,
          score: SCORE_POSTABLE,
          status: "new",
        },
        now,
      );
      if (item.outcome === "duplicate" || item.id === null) continue;

      if (!budget.take(1)) break;
      await enqueueForApproval(env, item.id, "INSTITUTIONAL_13F_BREAKDOWN", payload, url, now);
      carded += 1;
    }

    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);
    if (carded > 0) log("info", "13f cards", { carded, considered: due.results.length });
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    await recordSourceError(env.DB, SOURCE, e, now).catch(() => {});
    log("error", "13f card job failed", { error: String(e) });
  }
}
