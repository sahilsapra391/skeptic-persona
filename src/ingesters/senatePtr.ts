import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch, type PoliteResponse } from "../lib/http";
import { decodeEntities, extractAll, extractFirst } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { isFreshDateOnly } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Senate eFD (live-verified 2026-07-26; handshake + fixtures re-verified
// 2026-07-27T04:49-04:52Z, docs/verification/): a 3-step session handshake
// gates a DataTables JSON endpoint; electronic PTRs render as HTML tables;
// paper filings are scanned images (lake-only).
const BASE = "https://efdsearch.senate.gov";
export const EFD_HOME = `${BASE}/search/home/`;
export const EFD_DATA = `${BASE}/search/report/data/`;

export const SOURCE = "senate_ptr";
export const MAX_PAGE_FETCHES_PER_RUN = 5;

interface EfdSession {
  cookie: string; // "csrftoken=..; <lb>=..; sessionid=.."
  csrfToken: string; // csrftoken COOKIE value -> X-CSRFToken header
}

function cookiePairs(setCookies: string[]): string[] {
  return setCookies.map((c) => c.split(";")[0] ?? "").filter((p) => p.includes("="));
}

/**
 * Steps 1+2 (2 external fetches): GET home for csrftoken + LB cookies and the
 * HIDDEN csrfmiddlewaretoken (a DIFFERENT value than the cookie — verified),
 * then POST the agreement with redirect:"manual" — the 302 carries the
 * sessionid Set-Cookie we must capture.
 */
async function handshake(userAgent: string): Promise<EfdSession> {
  const home = await politeFetch(EFD_HOME, { userAgent, timeoutMs: 20_000 });
  if (!home.ok) throw new Error(`efd home ${home.status}`);
  const hidden = /name="csrfmiddlewaretoken" value="([^"]+)"/.exec(home.body)?.[1];
  if (!hidden) throw new Error("efd home: no csrfmiddlewaretoken");
  const jar = cookiePairs(home.setCookies);
  const csrfCookie = jar.find((p) => p.startsWith("csrftoken="))?.split("=")[1];
  if (!csrfCookie) throw new Error("efd home: no csrftoken cookie");

  const agree = await politeFetch(EFD_HOME, {
    userAgent,
    timeoutMs: 20_000,
    method: "POST",
    redirect: "manual",
    cookie: jar.join("; "),
    headers: { "content-type": "application/x-www-form-urlencoded", Referer: EFD_HOME },
    postBody: `prohibition_agreement=1&csrfmiddlewaretoken=${encodeURIComponent(hidden)}`,
  });
  if (agree.status !== 302) throw new Error(`efd agreement ${agree.status}`);
  const all = [...jar, ...cookiePairs(agree.setCookies)];
  if (!all.some((p) => p.startsWith("sessionid="))) throw new Error("efd agreement: no sessionid");
  return { cookie: all.join("; "), csrfToken: csrfCookie };
}

export interface EfdRow {
  firstName: string;
  lastName: string;
  display: string;
  kind: "ptr" | "paper";
  uuid: string;
  filedDate: string; // MM/DD/YYYY as served
}

const LINK_RE = /\/search\/view\/(ptr|paper)\/([0-9a-f-]{36})\//;

export function parseEfdRows(data: unknown): EfdRow[] {
  const body = data as { result?: string; data?: string[][] };
  if (body.result !== "ok" || !Array.isArray(body.data)) return [];
  const out: EfdRow[] = [];
  for (const row of body.data) {
    const link = row[3] ?? "";
    const m = LINK_RE.exec(link);
    if (!m) continue;
    out.push({
      firstName: (row[0] ?? "").trim(),
      lastName: (row[1] ?? "").trim(),
      display: decodeEntities((row[2] ?? "").trim()),
      kind: m[1] as "ptr" | "paper",
      uuid: m[2] ?? "",
      filedDate: (row[4] ?? "").trim(),
    });
  }
  return out;
}

export interface EfdTxn {
  transactionDate: string;
  owner: string;
  ticker: string | null; // '--' -> null
  assetName: string;
  assetType: string;
  type: string; // "Purchase" | "Sale (Full)" | ... as served
  amount: string; // VERBATIM band, e.g. "$1,001 - $15,000" — never midpoints
}

function cellText(cell: string): string {
  // Asset Name cells embed Company/Description <div>s (verified) — drop them
  // innermost-first so future NESTED wrappers can't leak tail text into a
  // draft, then strip remaining tags and collapse whitespace.
  let t = cell;
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/<div[^>]*>(?:(?!<div)[\s\S])*?<\/div>/g, "");
  }
  return decodeEntities(t.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export function parsePtrTable(html: string): EfdTxn[] {
  const out: EfdTxn[] = [];
  for (const row of extractAll(html, "tr")) {
    const cells = extractAll(row, "td").map(cellText);
    if (cells.length < 8) continue; // header/thead rows carry <th>
    const ticker = cells[3] ?? "";
    out.push({
      transactionDate: cells[1] ?? "",
      owner: cells[2] ?? "",
      ticker: ticker && ticker !== "--" ? ticker : null,
      assetName: cells[4] ?? "",
      assetType: cells[5] ?? "",
      type: cells[6] ?? "",
      amount: cells[7] ?? "",
    });
  }
  return out;
}

/** MM/DD/YYYY (date-only, as eFD serves it) -> ISO at UTC midnight. */
export function efdDateToIso(mdY: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdY.trim());
  if (!m) return "";
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}T00:00:00.000Z`;
}

function lagDays(filedIso: string, txnDate: string): number | null {
  const txnIso = efdDateToIso(txnDate);
  if (!filedIso || !txnIso) return null;
  const days = Math.round((new Date(filedIso).getTime() - new Date(txnIso).getTime()) / 86_400_000);
  return days >= 0 ? days : null;
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

/** Tier A draft; the disclosure-lag line is the built-in editorial (all parsed). */
export function draftSenatePtr(row: EfdRow, txns: EfdTxn[], filedIso: string): string {
  const who = row.display.replace(/\s*\(Senator\)\s*$/, "");
  const shown = txns.slice(0, 3).map((t) => {
    const what = t.ticker ?? (t.assetName.length > 40 ? `${t.assetName.slice(0, 40)}…` : t.assetName);
    return `${t.type} ${t.amount}, ${what} (${t.transactionDate})`;
  });
  const more = txns.length > 3 ? ` +${txns.length - 3} more` : "";
  // "After the LATEST trade" = the smallest per-transaction lag (the newest
  // trade is the one closest to the filing date).
  const lags = txns.map((t) => lagDays(filedIso, t.transactionDate)).filter((d): d is number => d !== null);
  const lag = lags.length > 0 ? `, disclosed ${Math.min(...lags)} days after the latest trade` : "";
  return `Senate PTR: ${who}. ${shown.join("; ")}${more}. Filed ${row.filedDate}${lag}`;
}

export async function pollSenatePtr(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);

  // Handshake (2) + data (1); page fetches on demand.
  if (!budget.take(3)) {
    log("warn", "tick budget exhausted before senate_ptr poll; deferring");
    return;
  }

  try {
    let session: EfdSession;
    try {
      session = await handshake(userAgent);
    } catch (e) {
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
      log("warn", "senate_ptr handshake failed", { error: String(e), failures: state.consecutiveFailures });
      return;
    }

    // Watermark: look back 7 days regardless (dedup absorbs overlap; the
    // window covers weekends/holidays and any missed polls).
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const mm = String(since.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(since.getUTCDate()).padStart(2, "0");
    const sinceStr = `${mm}/${dd}/${since.getUTCFullYear()} 00:00:00`;

    const dataBody = [
      "draw=1",
      "start=0",
      "length=100",
      `report_types=${encodeURIComponent("[11]")}`,
      `filer_types=${encodeURIComponent("[]")}`,
      `submitted_start_date=${encodeURIComponent(sinceStr)}`,
      "submitted_end_date=",
      "candidate_state=",
      "senator_state=",
      "office_id=",
      "first_name=",
      "last_name=",
      `${encodeURIComponent("order[0][column]")}=4`,
      `${encodeURIComponent("order[0][dir]")}=desc`,
      `${encodeURIComponent("columns[4][data]")}=4`,
    ].join("&");

    const fetchData = (): Promise<PoliteResponse> =>
      politeFetch(EFD_DATA, {
        userAgent,
        timeoutMs: 20_000,
        method: "POST",
        cookie: session.cookie,
        postBody: dataBody,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Referer: `${BASE}/search/`,
          "X-CSRFToken": session.csrfToken,
          "X-Requested-With": "XMLHttpRequest",
        },
      });

    let dataRes = await fetchData();
    // VERIFIED misleading failure mode: a dead session answers 503 with the
    // Senate "Site Under Maintenance" page. One fresh-handshake retry.
    if (dataRes.status === 503 && budget.take(3)) {
      log("warn", "senate_ptr data 503; retrying with fresh handshake");
      session = await handshake(userAgent);
      dataRes = await fetchData();
    }
    if (!dataRes.ok) {
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
      log("warn", "senate_ptr data non-2xx", { status: dataRes.status, failures: state.consecutiveFailures });
      return;
    }

    let rows: EfdRow[] = [];
    try {
      rows = parseEfdRows(JSON.parse(dataRes.body));
    } catch {
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
      log("warn", "senate_ptr data not JSON; possible shape drift", { bodyPrefix: dataRes.body.slice(0, 120) });
      return;
    }

    let inserted = 0;
    let pagesFetched = 0;
    for (const row of rows) {
      const filedIso = efdDateToIso(row.filedDate);
      const viewUrl = `${BASE}/search/view/${row.kind}/${row.uuid}/`;

      if (row.kind === "paper") {
        // Scanned images; no table to parse. Lake-only, never guessed at.
        const res = await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: row.uuid,
            category: "congress",
            eventAt: filedIso || null,
            sourceUrl: viewUrl,
            payload: { kind: "paper", display: row.display, firstName: row.firstName, lastName: row.lastName, filedDate: row.filedDate },
            score: SCORE_LOG_ONLY,
            status: "logged",
          },
          now,
        );
        if (res.outcome === "inserted") inserted += 1;
        continue;
      }

      // Electronic: fetch + parse the table BEFORE inserting, so the item
      // lands complete (low volume makes single-phase safe here).
      const exists = await env.DB.prepare(`SELECT 1 AS x FROM items WHERE dedup_key = ?1`)
        .bind(`${SOURCE}:${row.uuid}`)
        .first();
      if (exists) continue;
      if (pagesFetched >= MAX_PAGE_FETCHES_PER_RUN || !budget.take(1)) continue; // next poll picks it up

      pagesFetched += 1;
      let page = null;
      try {
        page = await politeFetch(viewUrl, { userAgent, timeoutMs: 20_000, cookie: session.cookie });
      } catch (e) {
        log("warn", "senate_ptr page fetch threw", { uuid: row.uuid, error: String(e) });
      }
      if (!page || !page.ok) {
        // Transient failures retry on later polls; a hard 404 or a filing
        // older than 2 days goes to the lake NOW — otherwise it would burn a
        // page slot every poll for 7 days and then vanish un-lake'd.
        const ageDays = filedIso ? (now.getTime() - new Date(filedIso).getTime()) / 86_400_000 : 99;
        if (page?.status === 404 || ageDays >= 2) {
          const res = await insertItem(
            env.DB,
            {
              source: SOURCE,
              externalId: row.uuid,
              category: "congress",
              eventAt: filedIso || null,
              sourceUrl: viewUrl,
              payload: {
                kind: "ptr",
                display: row.display,
                firstName: row.firstName,
                lastName: row.lastName,
                filedDate: row.filedDate,
                transactions: null,
                fetchFailed: page?.status ?? "network",
              },
              score: SCORE_LOG_ONLY,
              status: "logged",
            },
            now,
          );
          if (res.outcome === "inserted") inserted += 1;
        } else {
          log("warn", "senate_ptr page fetch failed; will retry", { uuid: row.uuid, status: page?.status ?? null });
        }
        continue;
      }
      const txns = parsePtrTable(page.body);
      const parsedOk = txns.length > 0;
      // All beat fields describe the NEWEST transaction, the same one the
      // lag line refers to: mixing txns[0]'s date with the min lag would
      // imply a disclosure speed that isn't true of either trade.
      const dated = txns.filter((t) => lagDays(filedIso, t.transactionDate) !== null);
      const newest = dated.slice().sort((a, b) => (lagDays(filedIso, a.transactionDate)! < lagDays(filedIso, b.transactionDate)! ? -1 : 1))[0];
      const minLag = newest ? lagDays(filedIso, newest.transactionDate) : null;
      const singleTxn = txns.length === 1;
      const fresh = isFreshDateOnly(filedIso, now);
      if (parsedOk && !fresh) {
        log("info", "senate_ptr stale-at-ingest suppressed", { uuid: row.uuid, filedDate: row.filedDate });
      }
      const draft = parsedOk ? draftSenatePtr(row, txns, filedIso) : "";
      const res = await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: row.uuid,
          category: "congress",
          eventAt: filedIso || null,
          sourceUrl: viewUrl,
          payload: {
            kind: "ptr",
            display: row.display,
            firstName: row.firstName,
            lastName: row.lastName,
            filedDate: row.filedDate,
            transactions: txns,
            // Template-engine fields (rendered at enqueue, not frozen here).
            factLine: draft,
            who: row.display.replace(/\s*\(Senator\)\s*$/, ""),
            tradeLine: txns
              .slice(0, 3)
              .map((t) => `${t.type} ${t.amount}, ${t.ticker ?? t.assetName.slice(0, 40)} (${t.transactionDate})`)
              .join("; "),
            tradeDate: newest?.transactionDate ?? null,
            amountBand: newest?.amount ?? null,
            singleTxn,
            lagDays: minLag,
            bandSpanRatio: bandSpan(newest?.amount ?? ""),
            bandWidthUsd: bandWidth(newest?.amount ?? ""),
          },
          score: parsedOk ? SCORE_POSTABLE : SCORE_LOG_ONLY,
          status: parsedOk && fresh ? "new" : "logged",
        },
        now,
      );
      if (res.outcome === "inserted") inserted += 1;
    }

    // Drain: same payload.draft pattern as form4.
    const pending = await env.DB.prepare(
      `SELECT id, source_url, payload FROM items
       WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 5`,
    )
      .bind(SOURCE, SCORE_POSTABLE)
      .all<{ id: number; source_url: string; payload: string }>();
    let enqueued = 0;
    for (const item of pending.results) {
      if (!budget.take(1)) break;
      const payload = JSON.parse(item.payload) as Record<string, unknown>;
      const result = await enqueueForApproval(env, item.id, "CONGRESS_PTR", payload, item.source_url, now);
      enqueued += 1;
      if (result.retryAfter !== null) break;
    }

    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);
    if (inserted > 0 || enqueued > 0) log("info", "senate_ptr poll", { inserted, enqueued });
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    log("error", "senate_ptr poll failed", { error: String(e) });
  }
}
