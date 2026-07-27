import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { recordFacts } from "../lookback";
import { enqueueForApproval } from "../pipeline/enqueue";
import { fmtNum } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// CFTC Traders in Financial Futures (TFF), weekly. Live-verified
// 2026-07-27T23:23Z: 200, 91 distinct contracts, E-MINI S&P 500 showing
// leveraged funds long 134,932 against short 496,807 on 1.97M open interest.
//
// WHY THIS SOURCE IS UNUSUALLY SAFE: CFTC pre-computes every week-over-week
// delta (change_in_lev_money_long, etc). We do NO arithmetic beyond
// long-minus-short, so the no-fabrication rule is satisfied by construction
// rather than by discipline. Nobody in the competitor corpus posts it.
const CFTC_BASE = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";

export const SOURCE = "cftc_cot";
export const CFTC_PAGE = "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm";

/**
 * Contract names taken VERBATIM from the live API (2026-07-27). CFTC's names
 * are idiosyncratic ("NASDAQ MINI", "ULTRA UST 10Y"), so these are copied
 * rather than guessed — a near-miss silently returns nothing.
 */
export const WATCHED_CONTRACTS = [
  "E-MINI S&P 500",
  "NASDAQ MINI",
  "RUSSELL E-MINI",
  "ULTRA UST 10Y",
  "ULTRA UST BOND",
  "VIX FUTURES",
  "FED FUNDS",
  "EURO FX",
  "JAPANESE YEN",
] as const;

export function cotUrl(): string {
  const list = WATCHED_CONTRACTS.map((c) => `'${c.replace(/'/g, "''")}'`).join(",");
  const params = new URLSearchParams({
    $where: `contract_market_name in(${list})`,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: "60",
  });
  return `${CFTC_BASE}?${params.toString()}`;
}

export interface CotRow {
  contract: string;
  market: string;
  reportDate: string; // ISO date
  openInterest: number | null;
  levLong: number | null;
  levShort: number | null;
  changeLevLong: number | null;
  changeLevShort: number | null;
  /** long - short, from two parsed fields. */
  levNet: number | null;
  /** Change in the net, from CFTC's own two deltas. */
  changeLevNet: number | null;
}

const num = (v: unknown): number | null => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};

export function parseCot(body: string): CotRow[] {
  const rows = JSON.parse(body) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  const out: CotRow[] = [];
  for (const r of rows) {
    const contract = String(r.contract_market_name ?? "").trim();
    const reportDate = String(r.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    if (!contract || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) continue;

    const levLong = num(r.lev_money_positions_long);
    const levShort = num(r.lev_money_positions_short);
    const changeLevLong = num(r.change_in_lev_money_long);
    const changeLevShort = num(r.change_in_lev_money_short);
    out.push({
      contract,
      market: String(r.market_and_exchange_names ?? "").trim(),
      reportDate,
      openInterest: num(r.open_interest_all),
      levLong,
      levShort,
      changeLevLong,
      changeLevShort,
      levNet: levLong !== null && levShort !== null ? levLong - levShort : null,
      changeLevNet:
        changeLevLong !== null && changeLevShort !== null ? changeLevLong - changeLevShort : null,
    });
  }
  return out;
}

/** Positioning is only news when it MOVED materially or the net is extreme. */
export const BIG_NET_CHANGE = 20_000;

export function scoreCot(row: CotRow): number {
  if (row.levNet === null || row.openInterest === null || row.openInterest === 0) return SCORE_LOG_ONLY;
  if (row.changeLevNet !== null && Math.abs(row.changeLevNet) >= BIG_NET_CHANGE) return SCORE_AUTO_ALERT;
  // A net position worth a fifth of all open interest is notable on its own.
  if (Math.abs(row.levNet) / row.openInterest >= 0.2) return SCORE_POSTABLE;
  return SCORE_LOG_ONLY;
}

/** Tier A. "net long/short" is subtraction over two CFTC fields, nothing more. */
export function draftCot(row: CotRow): string {
  const side = (row.levNet ?? 0) >= 0 ? "net long" : "net short";
  const size = fmtNum(Math.abs(row.levNet ?? 0));
  const wk =
    row.changeLevNet !== null
      ? `, ${row.changeLevNet >= 0 ? "up" : "down"} ${fmtNum(Math.abs(row.changeLevNet))} on the week`
      : "";
  return `CFTC positioning: leveraged funds ${side} ${size} ${row.contract} contracts${wk}, week ending ${row.reportDate}`;
}

export async function pollCftc(env: Env, now: Date = new Date(), budget: TickBudget = newTickBudget()): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, SOURCE);
  try {
    const res = await politeFetch(cotUrl(), { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000 });
    if (!res.ok) throw new Error(`cftc ${res.status}`);
    const rows = parseCot(res.body);
    if (rows.length === 0) throw new Error("parsed to zero rows");

    // Only the newest report week: the API returns history and reposting last
    // month's positioning as news would be stale-data-as-current.
    const newest = rows.reduce((a, b) => (a.reportDate >= b.reportDate ? a : b)).reportDate;
    for (const row of rows.filter((r) => r.reportDate === newest)) {
      const score = scoreCot(row);
      const result = await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: `${row.contract}:${row.reportDate}`,
          category: "positioning",
          eventAt: `${row.reportDate}T00:00:00.000Z`,
          sourceUrl: CFTC_PAGE,
          payload: { ...row, factLine: draftCot(row) },
          score,
          status: score >= SCORE_POSTABLE ? "new" : "logged",
        },
        now,
      );
      if (result.outcome === "inserted" && result.id !== null && row.levNet !== null) {
        await recordFacts(
          env.DB,
          [
            {
              itemId: result.id,
              source: SOURCE,
              entity: row.contract,
              metric: "lev_money_net",
              value: row.levNet,
              occurredAt: `${row.reportDate}T00:00:00.000Z`,
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
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    log("error", "cftc poll failed", { error: String(e), failures: state.consecutiveFailures });
    return;
  }

  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 2`,
  )
    .bind(SOURCE, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "POSITIONING", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
