import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { extractAll, extractFirst, stripBom, decodeEntities } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_IGNORE, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { isFreshAtIngest } from "./shared";
import { ET, iso, zonedTimeToUtc } from "../lib/time";
import { log } from "../lib/log";

// Trading halts (live-verified 2026-07-26; fixtures captured
// 2026-07-27T05:24Z). Nasdaq RSS: ttl=1 sanctions 60s polling, capped at 25
// items, CROSS-market (NASDAQ/AMEX observed), pubDate is date-only — the
// real timestamp is ndaq:HaltDate + ndaq:HaltTime (ET, no zone marker).
// NYSE CSV: snapshot of outstanding halts (not an event stream), Cloudflare
// edge cache 300s -> 5 min floor, prose Reasons, triple-quoted names.
// BOTH feeds share items.source 'halt' with a normalized key so the same
// halt arriving twice cross-feed dedups to one item.
export const NASDAQ_HALTS_FEED = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts";
export const NASDAQ_HALTS_PAGE = "https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts";
export const NYSE_HALTS_CSV = "https://www.nyse.com/api/trade-halts/current/download";

export const SOURCE = "halt";

/** Official code meanings (verified legend), auto-post grades. */
export const HALT_CODES: Record<string, { meaning: string; score: number }> = {
  T1: { meaning: "News Pending", score: SCORE_AUTO_ALERT },
  T2: { meaning: "News Released", score: SCORE_AUTO_ALERT },
  H10: { meaning: "SEC Trading Suspension", score: SCORE_AUTO_ALERT },
  MWC1: { meaning: "Market-Wide Circuit Breaker Level 1", score: SCORE_AUTO_ALERT },
  MWC2: { meaning: "Market-Wide Circuit Breaker Level 2", score: SCORE_AUTO_ALERT },
  MWC3: { meaning: "Market-Wide Circuit Breaker Level 3", score: SCORE_AUTO_ALERT },
  T5: { meaning: "Single-Stock Trading Pause", score: SCORE_POSTABLE },
  T6: { meaning: "Extraordinary Market Activity", score: SCORE_POSTABLE },
  T8: { meaning: "ETF Halt", score: SCORE_POSTABLE },
  T12: { meaning: "Additional Information Requested by Nasdaq", score: SCORE_POSTABLE },
  H4: { meaning: "Non-Compliance", score: SCORE_POSTABLE },
  H9: { meaning: "Not Current in Required Filings", score: SCORE_POSTABLE },
  H11: { meaning: "Regulatory Concern", score: SCORE_AUTO_ALERT },
  LUDP: { meaning: "Volatility Trading Pause", score: SCORE_POSTABLE },
  LUDS: { meaning: "Volatility Trading Pause — Straddle", score: SCORE_POSTABLE },
  O1: { meaning: "Operations Halt", score: SCORE_POSTABLE },
};

/**
 * Known NYSE prose reasons (it serves prose, not codes). NOTE: these grades
 * are informational only — NYSE rows are ALWAYS ingested log-only (see
 * parseNyseHalts). Its snapshot carries the time the halt entered the
 * snapshot, which does NOT agree with Nasdaq's event timestamps for the same
 * security (verified: SBEV/AMZE/SVA differ by days-to-years across the two
 * captures), so cross-feed dedup can't be trusted to prevent a double post.
 * Nasdaq RSS — with official codes and true halt times — owns the event.
 */
export const NYSE_KNOWN_REASONS = new Set(["News Pending", "News Released", "Regulatory Concern", "Corporate Action"]);

export interface HaltEvent {
  symbol: string;
  name: string;
  market: string;
  reasonCode: string | null; // Nasdaq path
  reasonText: string; // meaning or NYSE prose
  haltDate: string; // MM/DD/YYYY or YYYY-MM-DD as served
  haltTime: string; // HH:MM:SS (millis stripped)
  eventIso: string;
  score: number;
}

function haltKey(e: HaltEvent): string {
  // eventIso normalizes both feeds' date formats and both are ET wall clock.
  return `${e.symbol}|${e.eventIso}`;
}

function etToUtcIso(dateStr: string, timeStr: string): string {
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr.trim());
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const t = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(timeStr.trim());
  if (!t) return "";
  let y: number, mo: number, d: number;
  if (mdy) [y, mo, d] = [Number(mdy[3]), Number(mdy[1]), Number(mdy[2])];
  else if (ymd) [y, mo, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else return "";
  return zonedTimeToUtc(ET, y, mo, d, Number(t[1]), Number(t[2]), Number(t[3])).toISOString();
}

export function parseNasdaqHalts(xml: string): HaltEvent[] {
  const out: HaltEvent[] = [];
  for (const item of extractAll(stripBom(xml), "item")) {
    const symbol = (extractFirst(item, "ndaq:IssueSymbol") ?? "").trim();
    const haltDate = (extractFirst(item, "ndaq:HaltDate") ?? "").trim();
    const haltTimeRaw = (extractFirst(item, "ndaq:HaltTime") ?? "").trim();
    if (!symbol || !haltDate || !haltTimeRaw) continue;
    const haltTime = haltTimeRaw.replace(/\.\d+$/, "");
    const code = (extractFirst(item, "ndaq:ReasonCode") ?? "").trim();
    const known = HALT_CODES[code];
    if (!known && code) log("warn", "unknown halt reason code", { code });
    out.push({
      symbol,
      name: decodeEntities((extractFirst(item, "ndaq:IssueName") ?? "").trim()),
      market: (extractFirst(item, "ndaq:Market") ?? "").trim(),
      reasonCode: code || null,
      reasonText: known?.meaning ?? code,
      haltDate,
      haltTime,
      eventIso: etToUtcIso(haltDate, haltTime),
      score: known?.score ?? SCORE_LOG_ONLY,
    });
  }
  return out;
}

/** Minimal CSV splitter handling quoted fields (verified triple-quote artifact). */
function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  // Verified artifact: names arrive triple-quoted; strip residual quotes.
  return out.map((v) => v.replace(/^"+|"+$/g, "").trim());
}

export function parseNyseHalts(csv: string): HaltEvent[] {
  const lines = csv.split("\n").map((l) => l.replace(/\r$/, ""));
  const out: HaltEvent[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [haltDate, haltTime, symbol, name, market, reason] = csvSplit(line);
    if (!symbol || !haltDate || !haltTime) continue;
    if (reason && !NYSE_KNOWN_REASONS.has(reason)) {
      log("warn", "unknown nyse halt reason", { reason });
    }
    // Lake-only by construction (never SCORE_POSTABLE): see NYSE_KNOWN_REASONS.
    const score = SCORE_LOG_ONLY;
    out.push({
      symbol,
      name: name ?? "",
      market: market ?? "",
      reasonCode: null,
      reasonText: reason ?? "",
      haltDate,
      haltTime,
      eventIso: etToUtcIso(haltDate, haltTime),
      score,
    });
  }
  return out;
}

/** Tier A: symbol, exchange-stated reason, ET time — all parsed. */
export function draftHalt(e: HaltEvent): string {
  const name = e.name ? ` (${e.name})` : "";
  const hhmm = e.haltTime.slice(0, 5);
  return `HALT: ${e.symbol}${name} — ${e.reasonText}, ${hhmm} ET`;
}

async function ingestHalts(env: Env, events: HaltEvent[], sourceUrl: string, now: Date): Promise<number> {
  let inserted = 0;
  for (const e of events) {
    if (!e.eventIso) continue;
    const result = await insertItem(
      env.DB,
      {
        source: SOURCE,
        externalId: haltKey(e),
        category: "halt",
        eventAt: e.eventIso,
        sourceUrl,
        payload: {
          symbol: e.symbol,
          name: e.name,
          market: e.market,
          reasonCode: e.reasonCode,
          reasonText: e.reasonText,
          haltTimeEt: `${e.haltDate} ${e.haltTime}`,
          draft: draftHalt(e),
        },
        score: e.score,
        status: e.score >= SCORE_POSTABLE && isFreshAtIngest(e.eventIso, now) ? "new" : "logged",
      },
      now,
    );
    if (result.outcome === "inserted") inserted += 1;
  }
  return inserted;
}

async function drainHalts(env: Env, now: Date, budget: TickBudget): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items
     WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 5`,
  )
    .bind(SOURCE, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  let enqueued = 0;
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as { draft?: string };
    const result = await enqueueForApproval(env, row.id, "WIRE", payload.draft ?? "", row.source_url, now);
    enqueued += 1;
    if (result.retryAfter !== null) break;
  }
  return enqueued;
}

function makeHaltPoller(
  stateKey: string,
  url: string,
  sourceUrl: string,
  parse: (body: string) => HaltEvent[],
): (env: Env, now: Date, budget?: TickBudget) => Promise<void> {
  return async (env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> => {
    const state = await getSourceState(env.DB, stateKey);
    state.lastPolledAt = iso(now);
    if (!budget.take(1)) {
      log("warn", "tick budget exhausted before halt poll; deferring", { source: stateKey });
      return;
    }
    let res;
    try {
      res = await politeFetch(url, {
        userAgent: buildUserAgent(env.CONTACT_EMAIL),
        timeoutMs: 15_000,
        validators: { etag: state.etag, lastModified: state.lastModified },
      });
    } catch (e) {
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
      log("warn", "halt feed fetch failed", { source: stateKey, error: String(e), failures: state.consecutiveFailures });
      return;
    }
    try {
      if (!res.notModified) {
        if (!res.ok) {
          state.consecutiveFailures += 1;
          await putSourceState(env.DB, state);
          log("warn", "halt feed non-2xx", { source: stateKey, status: res.status });
          return;
        }
        const events = parse(res.body);
        if (events.length === 0) {
          // Both feeds carry weeks of history (verified); empty means a bot
          // challenge (Imperva serves text/html) or shape drift.
          state.consecutiveFailures += 1;
          await putSourceState(env.DB, state);
          log("warn", "halt feed parsed to zero events; possible challenge or drift", {
            source: stateKey,
            contentType: res.contentType,
            bodyPrefix: res.body.slice(0, 120),
          });
          return;
        }
        await ingestHalts(env, events, sourceUrl, now);
        state.etag = res.etag;
        state.lastModified = res.lastModified;
      }
      await drainHalts(env, now, budget);
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
      await putSourceState(env.DB, state);
    } catch (e) {
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state).catch(() => {});
      log("error", "halt poll failed", { source: stateKey, error: String(e) });
    }
  };
}

export const pollNasdaqHalts = makeHaltPoller("halts_nasdaq", NASDAQ_HALTS_FEED, NASDAQ_HALTS_PAGE, parseNasdaqHalts);
export const pollNyseHalts = makeHaltPoller("halts_nyse", NYSE_HALTS_CSV, NYSE_HALTS_CSV, parseNyseHalts);
