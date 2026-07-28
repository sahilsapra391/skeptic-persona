import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Nasdaq Reg SHO Threshold Securities List. Live-verified 2026-07-28T04:18Z:
// 200, 2,485 bytes, pipe-delimited.
//
// WHY IT EARNS A SLOT: a security appears here only after FIVE consecutive
// settlement days with fails-to-deliver at 0.5%+ of shares outstanding. Both
// the entry and the exit are filed, primary-source signals of persistent
// settlement failure — and nobody in the 19,518-post competitor corpus posts
// them.
//
// THE PRODUCT IS THE DIFF, not the list. The list barely changes day to day;
// what is news is who JOINED and who LEFT.
export const SOURCE = "regsho_threshold";
export const REGSHO_PAGE = "https://www.nasdaqtrader.com/Trader.aspx?id=RegSHOThreshold";

export function regShoUrl(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `https://www.nasdaqtrader.com/dynamic/symdir/regsho/nasdaqth${y}${m}${day}.txt`;
}

export interface ThresholdRow {
  symbol: string;
  name: string;
  /** Nasdaq's own category letter: G = global/ETF, S = small cap. */
  marketCategory: string;
}

/**
 * Pipe-delimited with a header row. Verified columns:
 * Symbol|Security Name|Market Category|Reg SHO Threshold Flag|Rule 3210|Filler
 */
export function parseThreshold(body: string): ThresholdRow[] {
  const out: ThresholdRow[] = [];
  const lines = body.split("\n");
  for (const line of lines.slice(1)) {
    const cells = line.split("|");
    if (cells.length < 4) continue;
    const symbol = (cells[0] ?? "").trim();
    // Nasdaq appends a trailing record count line on some files.
    if (!symbol || /^\d/.test(symbol)) continue;
    const flag = (cells[3] ?? "").trim().toUpperCase();
    // Only rows actually flagged as threshold securities.
    if (flag !== "Y") continue;
    out.push({
      symbol,
      name: (cells[1] ?? "").trim(),
      marketCategory: (cells[2] ?? "").trim(),
    });
  }
  return out;
}

export interface ThresholdDiff {
  entered: ThresholdRow[];
  exited: string[];
  total: number;
}

export function diffThreshold(prev: readonly string[], current: readonly ThresholdRow[]): ThresholdDiff {
  const prevSet = new Set(prev);
  const currentSet = new Set(current.map((r) => r.symbol));
  return {
    entered: current.filter((r) => !prevSet.has(r.symbol)),
    exited: prev.filter((s) => !currentSet.has(s)),
    total: current.length,
  };
}

/** Tier A. Every figure is a count of parsed rows. */
export function draftThreshold(row: ThresholdRow, listDate: string): string {
  const name = row.name ? ` (${row.name})` : "";
  return `${row.symbol}${name} joined the Nasdaq Reg SHO threshold list, ${listDate}`;
}

export async function pollRegSho(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, SOURCE);

  // The file is published for the prior settlement day.
  const target = new Date(now.getTime() - 86_400_000);
  const listDate = target.toISOString().slice(0, 10);

  try {
    const res = await politeFetch(regShoUrl(target), {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
    });
    // No file on weekends and holidays; that is not an outage.
    if (res.status === 404) {
      log("info", "no reg sho file for date (weekend or holiday)", { date: listDate });
      state.lastOkAt = iso(now);
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
      return;
    }
    if (!res.ok) throw new Error(`regsho ${res.status}`);

    const rows = parseThreshold(res.body);
    if (rows.length === 0) throw new Error("parsed to zero threshold rows");

    // The cursor holds yesterday's symbol set, so the diff is against what we
    // actually observed rather than against an assumption.
    const prev: string[] = state.cursor ? (JSON.parse(state.cursor) as string[]) : [];
    const isFirstRun = prev.length === 0;
    const diff = diffThreshold(prev, rows);

    for (const entry of diff.entered) {
      await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: `${entry.symbol}:${listDate}`,
          category: "market_structure",
          eventAt: `${listDate}T00:00:00.000Z`,
          sourceUrl: REGSHO_PAGE,
          payload: {
            symbol: entry.symbol,
            name: entry.name,
            marketCategory: entry.marketCategory,
            listDate,
            listSize: diff.total,
            factLine: draftThreshold(entry, listDate),
          },
          // BASELINE RULE: on the first run every symbol looks new because we
          // have no prior list. Claiming 30 securities "joined" would be
          // fabrication by omission of context.
          score: isFirstRun ? SCORE_LOG_ONLY : SCORE_POSTABLE,
          status: isFirstRun ? "logged" : "new",
        },
        now,
      );
    }

    if (!isFirstRun && (diff.entered.length > 0 || diff.exited.length > 0)) {
      log("info", "reg sho threshold diff", {
        date: listDate,
        entered: diff.entered.map((e) => e.symbol),
        exited: diff.exited,
        total: diff.total,
      });
    }

    state.cursor = JSON.stringify(rows.map((r) => r.symbol));
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    await recordSourceError(env.DB, SOURCE, e, now);
    log("error", "reg sho poll failed", { error: String(e) });
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
    const result = await enqueueForApproval(env, row.id, "SETTLEMENT_FAILURE", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
