import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAll, extractAttr, extractFirst, stripBom } from "../lib/xml";
import {
  getSourceState,
  insertItem,
  prepareInsiderTrade,
  putSourceState,
  SCORE_AUTO_ALERT,
  SCORE_LOG_ONLY,
  SCORE_POSTABLE,
  updateItemDetail,
} from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { fmtNum, fmtUsd, isFreshAtIngest } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Live-verified 2026-07-26 (feed shape, entry duplication, ownership XML tag
// names) and 2026-07-27T03:04-03:06Z (fixtures captured; count=100 +
// start=100 paging returns 100+100 entries; getcompany URL pattern 200).
// See docs/verification/.
const FEED_BASE =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&output=atom";
export const FORM4_FEED = `${FEED_BASE}&count=100`;
export const FORM4_FEED_PAGE2 = `${FEED_BASE}&start=100&count=100`;

export const SOURCE = "edgar_form4";
export const CLUSTER_SOURCE = "insider_cluster";

// --- Editorial policy (tunable constants, not fabrication: they only gate
// visibility; every number in a draft is parsed from the ownership XML). ---
export const BUY_POSTABLE_USD = 100_000; // open-market buys (code P) at/above -> postable
export const BUY_ALERT_USD = 1_000_000; // -> auto-alert grade
export const SELL_POSTABLE_USD = 5_000_000; // big open-market dumps (code S) -> postable
export const CLUSTER_MIN_INSIDERS = 3;
/** ~5 trading sessions; drafts only ever claim "the past week" (calendar truth). */
export const CLUSTER_WINDOW_DAYS = 7;

/** Per-run caps; the shared tick budget can shrink these further. */
export const DETAIL_BATCH_PER_RUN = 8; // 2 external fetches each
export const MAX_ENQUEUES_PER_RUN = 5;
const MAX_DETAIL_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Feed parsing. VERIFIED QUIRK: every filing appears at least twice per page
// (one entry per Reporting owner + one per Issuer) with the same accession in
// <id> — dedup on accession is mandatory, not defensive.

export interface Form4FeedEntry {
  accession: string;
  formType: string; // "4" | "4/A"
  indexUrl: string;
  dirUrl: string;
  filedIso: string;
}

const ACCESSION_RE = /accession-number=([0-9-]+)/;

export function parseForm4Feed(xml: string): Form4FeedEntry[] {
  const out: Form4FeedEntry[] = [];
  const seen = new Set<string>();
  for (const entry of extractAll(stripBom(xml), "entry")) {
    const accession = ACCESSION_RE.exec(extractFirst(entry, "id") ?? "")?.[1];
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);

    const formType = extractAttr(entry, "category", "term") ?? "4";
    const indexUrl = extractAttr(entry, "link", "href") ?? "";
    const dirUrl = indexUrl.replace(/\/[^/]*$/, "");
    const updated = extractFirst(entry, "updated") ?? "";
    const filedAt = new Date(updated);
    const filedIso = Number.isNaN(filedAt.getTime()) ? "" : filedAt.toISOString();

    out.push({ accession, formType, indexUrl, dirUrl, filedIso });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ownership document parsing (verified tag names; leaf values wrapped in
// <value>; optional elements ABSENT not empty; booleans mixed '1'/'true').

export interface Form4Owner {
  cik: string;
  name: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercent: boolean;
  officerTitle: string | null;
}

export interface Form4Txn {
  securityTitle: string | null;
  date: string; // YYYY-MM-DD
  code: string;
  acquiredDisposed: "A" | "D" | null;
  shares: number | null;
  price: number | null;
  sharesAfter: number | null;
  direct: boolean;
  pctChange: number | null; // computed from parsed fields; null when not derivable
}

export interface Form4Doc {
  documentType: string;
  issuerCik: string;
  issuerName: string;
  ticker: string | null;
  owners: Form4Owner[];
  nonDerivative: Form4Txn[];
  derivativeCount: number;
}

function boolVal(s: string | null): boolean {
  return s === "1" || s === "true";
}

function nestedValue(block: string, tag: string): string | null {
  const inner = extractFirst(block, tag);
  if (inner === null) return null;
  const v = extractFirst(inner, "value");
  return v === null ? null : decodeEntities(v.trim());
}

function nestedNumber(block: string, tag: string): number | null {
  const v = nestedValue(block, tag);
  if (v === null || v === "") return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function parseForm4Xml(xml: string): Form4Doc | null {
  const clean = stripBom(xml);
  if (!clean.includes("<ownershipDocument")) return null;
  const issuerBlock = extractFirst(clean, "issuer") ?? "";
  const issuerCik = extractFirst(issuerBlock, "issuerCik")?.trim() ?? "";
  if (!issuerCik) return null;

  const owners: Form4Owner[] = extractAll(clean, "reportingOwner").map((block) => ({
    cik: extractFirst(block, "rptOwnerCik")?.trim() ?? "",
    name: decodeEntities(extractFirst(block, "rptOwnerName")?.trim() ?? ""),
    isDirector: boolVal(extractFirst(block, "isDirector")?.trim() ?? null),
    isOfficer: boolVal(extractFirst(block, "isOfficer")?.trim() ?? null),
    isTenPercent: boolVal(extractFirst(block, "isTenPercentOwner")?.trim() ?? null),
    officerTitle: decodeEntities(extractFirst(block, "officerTitle")?.trim() ?? "") || null,
  }));

  const nonDerivative: Form4Txn[] = extractAll(clean, "nonDerivativeTransaction").map((block) => {
    const shares = nestedNumber(block, "transactionShares");
    const sharesAfter = nestedNumber(block, "sharesOwnedFollowingTransaction");
    const adRaw = nestedValue(block, "transactionAcquiredDisposedCode");
    const acquiredDisposed = adRaw === "A" || adRaw === "D" ? adRaw : null;
    let pctChange: number | null = null;
    if (shares !== null && sharesAfter !== null && acquiredDisposed !== null) {
      const prior = acquiredDisposed === "D" ? sharesAfter + shares : sharesAfter - shares;
      if (prior > 0) pctChange = Math.round((shares / prior) * 1000) / 10;
    }
    return {
      securityTitle: nestedValue(block, "securityTitle"),
      date: nestedValue(block, "transactionDate") ?? "",
      code: extractFirst(extractFirst(block, "transactionCoding") ?? "", "transactionCode")?.trim() ?? "",
      acquiredDisposed,
      shares,
      price: nestedNumber(block, "transactionPricePerShare"),
      sharesAfter,
      direct: (nestedValue(block, "directOrIndirectOwnership") ?? "D") === "D",
      pctChange,
    };
  });

  return {
    documentType: extractFirst(clean, "documentType")?.trim() ?? "",
    issuerCik,
    issuerName: decodeEntities(extractFirst(issuerBlock, "issuerName")?.trim() ?? ""),
    ticker: decodeEntities(extractFirst(issuerBlock, "issuerTradingSymbol")?.trim() ?? "") || null,
    owners,
    nonDerivative,
    derivativeCount: extractAll(clean, "derivativeTransaction").length,
  };
}

// ---------------------------------------------------------------------------
// Scoring + drafting (Tier A: parsed fields and arithmetic on them only).

export interface Form4Totals {
  buyShares: number;
  buyValue: number;
  sellShares: number;
  sellValue: number;
}

/** Sums only transactions where BOTH shares and price parsed — no fabricated values. */
export function totalsFor(txns: Form4Txn[]): Form4Totals {
  const t: Form4Totals = { buyShares: 0, buyValue: 0, sellShares: 0, sellValue: 0 };
  for (const txn of txns) {
    if (txn.shares === null || txn.price === null) continue;
    if (txn.code === "P") {
      t.buyShares += txn.shares;
      t.buyValue += txn.shares * txn.price;
    } else if (txn.code === "S") {
      t.sellShares += txn.shares;
      t.sellValue += txn.shares * txn.price;
    }
  }
  return t;
}

export function scoreForm4(totals: Form4Totals): number {
  if (totals.buyValue >= BUY_ALERT_USD) return SCORE_AUTO_ALERT;
  if (totals.buyValue >= BUY_POSTABLE_USD) return SCORE_POSTABLE;
  if (totals.sellValue >= SELL_POSTABLE_USD) return SCORE_POSTABLE;
  return SCORE_LOG_ONLY;
}

export function ownerLabel(owner: Form4Owner): string {
  if (owner.officerTitle) return owner.officerTitle;
  if (owner.isDirector) return "Director";
  if (owner.isTenPercent) return "10% owner";
  return "Insider";
}

export function draftForm4(doc: Form4Doc, totals: Form4Totals): string {
  const owner = doc.owners[0];
  const who = owner ? `${owner.name} (${ownerLabel(owner)})` : "Insider";
  const sym = doc.ticker ?? doc.issuerName;
  const lines: string[] = [];
  // Every field in a line derives from the SAME priced subset the totals
  // cover — never a composite of priced totals with unpriced txns' dates or
  // stake (that would assert a false combination of true numbers).
  const priced = (side: "P" | "S") =>
    doc.nonDerivative.filter((t) => t.code === side && t.shares !== null && t.price !== null && t.date);
  const span = (txns: Form4Txn[]): string => {
    const dates = txns.map((t) => t.date).sort();
    const lo = dates[0];
    const hi = dates.at(-1);
    return lo ? (lo === hi ? ` on ${lo}` : ` over ${lo}–${hi}`) : "";
  };
  if (totals.buyValue > 0) {
    const buys = priced("P");
    const allBuys = doc.nonDerivative.filter((t) => t.code === "P");
    const avg = totals.buyValue / totals.buyShares;
    // Stake/pct only when the priced subset IS the whole buy picture and the
    // latest-dated buy carries a parsed post-transaction balance.
    const last = buys.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1);
    const stake =
      buys.length === allBuys.length && last && last.sharesAfter !== null
        ? `, stake now ${fmtNum(last.sharesAfter)} shares${last.pctChange !== null ? ` (+${last.pctChange}%)` : ""}`
        : "";
    lines.push(
      `Form 4: ${who} bought ${fmtNum(totals.buyShares)} ${sym} at ~$${avg.toFixed(2)} (${fmtUsd(totals.buyValue)})${span(buys)}${stake}`,
    );
  }
  if (totals.sellValue > 0) {
    const sells = priced("S");
    const avg = totals.sellValue / totals.sellShares;
    lines.push(
      `Form 4: ${who} sold ${fmtNum(totals.sellShares)} ${sym} at ~$${avg.toFixed(2)} (${fmtUsd(totals.sellValue)})${span(sells)}`,
    );
  }
  return lines.join("\n") || `Form 4: ${who} — ${sym}`;
}

// ---------------------------------------------------------------------------
// Cluster detection: >=3 DISTINCT insiders with open-market buys (code P) on
// the same issuer inside the window. The cluster item's dedup key is the
// member set, so it re-fires only when a NEW insider joins.

export function clusterSourceUrl(issuerCik: string): string {
  // Company's Form 4 list on EDGAR (URL pattern verified live 2026-07-27).
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${issuerCik}&type=4&dateb=&owner=include&count=10`;
}

export async function checkCluster(
  env: Env,
  issuer: { cik: string; name: string; ticker: string | null },
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - CLUSTER_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  // GROUP BY the CIK alone: rptOwnerName rendering varies by filing agent
  // ("Smith John" vs "SMITH JOHN"), and a name-variant duplicate would
  // fabricate the headline insider count.
  const members = await env.DB.prepare(
    `SELECT insider_cik, MAX(insider_name) AS insider_name,
            MAX(COALESCE(officer_title, CASE WHEN is_director = 1 THEN 'Director' ELSE 'Insider' END)) AS label,
            SUM(CASE WHEN shares IS NOT NULL AND price IS NOT NULL THEN shares * price END) AS value
     FROM insider_trades
     WHERE issuer_cik = ?1 AND code = 'P' AND transaction_date >= ?2
     GROUP BY insider_cik
     ORDER BY value DESC`,
  )
    .bind(issuer.cik, cutoff)
    .all<{ insider_cik: string; insider_name: string; label: string; value: number | null }>();

  if (members.results.length < CLUSTER_MIN_INSIDERS) return false;

  // "Buys only" asserts an ABSENCE, so it must be queried, never assumed:
  // the member query selects code-P rows, which says nothing about whether
  // those same filers also sold inside the window.
  const sells = await env.DB.prepare(
    `SELECT 1 AS x FROM insider_trades
     WHERE issuer_cik = ?1 AND code <> 'P' AND transaction_date >= ?2 LIMIT 1`,
  )
    .bind(issuer.cik, cutoff)
    .first<{ x: number }>();
  const allCodeP = sells === null;

  const key = `${issuer.cik}:${members.results
    .map((m) => m.insider_cik)
    .sort()
    .join("+")}`;
  const sym = issuer.ticker ?? issuer.name;
  // A footnote-only price parses to NULL; that member is named without a
  // dollar figure and the combined total is only claimed when every member's
  // value parsed (never a silently-partial sum presented as the whole).
  const who = members.results
    .map((m) => `${m.insider_name} (${m.label}) ${m.value !== null ? fmtUsd(m.value) : "amt n/a"}`)
    .join(", ");
  const allPriced = members.results.every((m) => m.value !== null);
  const total = members.results.reduce((s, m) => s + (m.value ?? 0), 0);
  const combined = allPriced ? `Combined ${fmtUsd(total)}.` : "";
  const draft =
    `Insider cluster: ${members.results.length} insiders bought ${sym} in the past week. ${who}.` +
    (combined ? ` ${combined.replace(/, $/, "")}` : "");

  const res = await insertItem(
    env.DB,
    {
      source: CLUSTER_SOURCE,
      externalId: key,
      category: "insider",
      eventAt: iso(now),
      sourceUrl: clusterSourceUrl(issuer.cik),
      payload: {
        factLine: draft,
        issuer,
        members: members.results,
        memberCount: members.results.length,
        symbol: sym,
        roster: who,
        allCodeP,
      },
      score: SCORE_AUTO_ALERT,
      status: "new",
    },
    now,
  );
  return res.outcome === "inserted";
}

// ---------------------------------------------------------------------------
// Poll: discovery -> stubs; bounded detail phase; cluster check; drain.

interface StubPayload {
  phase: "stub";
  formType: string;
  dirUrl: string;
  attempts: number;
}

async function processDetail(
  env: Env,
  row: { id: number; event_at: string | null; payload: string },
  userAgent: string,
  now: Date,
): Promise<void> {
  const stub = JSON.parse(row.payload) as StubPayload;
  try {
    const idx = await politeFetch(`${stub.dirUrl}/index.json`, { userAgent, timeoutMs: 20_000 });
    if (!idx.ok) throw new Error(`index.json ${idx.status}`);
    // Content-Type lies on Archives (verified) — parse body regardless.
    const dir = JSON.parse(idx.body) as { directory: { item: Array<{ name: string }> } };
    const xmlName = dir.directory.item.find(
      (i) => i.name.endsWith(".xml") && !i.name.startsWith("FilingSummary"),
    )?.name;
    if (!xmlName) throw new Error("no ownership xml in directory");

    const xmlRes = await politeFetch(`${stub.dirUrl}/${xmlName}`, { userAgent, timeoutMs: 20_000 });
    if (!xmlRes.ok) throw new Error(`ownership xml ${xmlRes.status}`);
    const doc = parseForm4Xml(xmlRes.body);
    if (!doc) throw new Error("ownership xml did not parse");

    const owner = doc.owners[0];
    const totals = totalsFor(doc.nonDerivative);
    const score = scoreForm4(totals);
    const fresh = isFreshAtIngest(row.event_at ?? "", now);
    const draft = draftForm4(doc, totals);

    // ONE atomic batch: the pending_detail-guarded flip plus every trade row
    // (OR IGNORE on the (item_id, txn_index) key). A crash can't strand an
    // item detailed-but-rowless, and an overlapping run that loses the flip
    // inserts nothing new — no duplicate dollars in future cluster sums.
    const stmts = [
      env.DB
        .prepare(`UPDATE items SET payload = ?1, score = ?2, status = ?3 WHERE id = ?4 AND status = 'pending_detail'`)
        .bind(
          JSON.stringify({
            phase: "detail",
            formType: stub.formType,
            issuer: { cik: doc.issuerCik, name: doc.issuerName, ticker: doc.ticker },
            owners: doc.owners,
            transactions: doc.nonDerivative,
            derivativeCount: doc.derivativeCount,
            totals,
            // Template-engine fields (rendered at enqueue, not frozen here).
            factLine: draft,
            who: owner ? `${owner.name} (${ownerLabel(owner)})` : null,
            actionLine: draft.replace(/^Form 4: .*?\) /, ""),
            // Derived from the PRINTED subset, not document order: a
            // footnote-priced buy is excluded from the fact line, so it must
            // not license "Code P. Bought, not granted." on a sell post.
            primaryCode:
              totals.buyValue > 0 && totals.sellValue === 0
                ? "P"
                : totals.sellValue > 0 && totals.buyValue === 0
                  ? "S"
                  : null,
            lagDays: (() => {
              const dates = doc.nonDerivative.filter((t) => t.date).map((t) => t.date).sort();
              const newest = dates.at(-1);
              if (!newest || !row.event_at) return null;
              const d = Math.round((new Date(row.event_at).getTime() - new Date(`${newest}T00:00:00Z`).getTime()) / 86_400_000);
              return d >= 0 ? d : null;
            })(),
            // Only true when the fact line actually prints a stake number.
            stakePrinted: (() => {
              const buys = doc.nonDerivative.filter((t) => t.code === "P" && t.shares !== null && t.price !== null && t.date);
              const allBuys = doc.nonDerivative.filter((t) => t.code === "P");
              const last = buys.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1);
              return buys.length === allBuys.length && !!last && last.sharesAfter !== null;
            })(),
            isAmendment: stub.formType.endsWith("/A"),
          }),
          score,
          score >= SCORE_POSTABLE && fresh ? "new" : "logged",
          row.id,
        ),
    ];
    if (owner) {
      doc.nonDerivative.forEach((txn, txnIndex) => {
        if (!txn.date) return;
        stmts.push(
          prepareInsiderTrade(env.DB, {
            itemId: row.id,
            txnIndex,
            issuerCik: doc.issuerCik,
            ticker: doc.ticker,
            insiderCik: owner.cik,
            insiderName: owner.name,
            isOfficer: owner.isOfficer,
            isDirector: owner.isDirector,
            officerTitle: owner.officerTitle,
            side: txn.code === "P" ? "buy" : txn.code === "S" ? "sell" : "other",
            code: txn.code,
            shares: txn.shares,
            price: txn.price,
            sharesAfter: txn.sharesAfter,
            pctChange: txn.pctChange,
            transactionDate: txn.date,
            isAmendment: stub.formType.endsWith("/A"),
          }),
        );
      });
    }
    const results = await env.DB.batch(stmts);
    const won = (results[0]?.meta.changes ?? 0) > 0;

    if (won && owner && doc.nonDerivative.some((t) => t.code === "P")) {
      await checkCluster(env, { cik: doc.issuerCik, name: doc.issuerName, ticker: doc.ticker }, now);
    }
  } catch (e) {
    const attempts = (stub.attempts ?? 0) + 1;
    const give_up = attempts >= MAX_DETAIL_ATTEMPTS;
    await updateItemDetail(
      env.DB,
      row.id,
      { ...stub, attempts },
      SCORE_LOG_ONLY,
      give_up ? "logged" : "pending_detail",
    );
    log(give_up ? "error" : "warn", "form4 detail fetch failed", { itemId: row.id, attempts, error: String(e) });
  }
}

async function drainPostables(env: Env, now: Date, budget: TickBudget): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id, source, source_url, payload FROM items
     WHERE source IN (?1, ?2) AND status = 'new' AND score >= ?3
     ORDER BY id LIMIT ?4`,
  )
    .bind(SOURCE, CLUSTER_SOURCE, SCORE_POSTABLE, MAX_ENQUEUES_PER_RUN)
    .all<{ id: number; source: string; source_url: string; payload: string }>();

  const spacingRaw = Number(env.QUEUE_NOTIFY_SPACING_MS ?? 1100);
  const spacingMs = Number.isFinite(spacingRaw) && spacingRaw >= 0 ? spacingRaw : 1100;

  let sent = 0;
  for (const row of pending.results) {
    if (!budget.take(1)) {
      log("warn", "tick budget exhausted; deferring remaining form4 notifications", {
        remaining: pending.results.length - sent,
      });
      break;
    }
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const archetype = row.source === CLUSTER_SOURCE ? "INSIDER_CLUSTER" : "FILING_FORM4";
    const result = await enqueueForApproval(env, row.id, archetype, payload, row.source_url, now);
    sent += 1;
    if (result.retryAfter !== null) {
      log("warn", "telegram flood control; deferring remaining form4 notifications", { retryAfter: result.retryAfter });
      break;
    }
    if (spacingMs > 0 && sent < pending.results.length) {
      await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
  }
  return sent;
}

export async function pollForm4(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);

  if (!budget.take(1)) {
    log("warn", "tick budget exhausted before form4 feed fetch; deferring poll");
    return;
  }
  let res;
  try {
    res = await politeFetch(FORM4_FEED, {
      userAgent,
      timeoutMs: 20_000,
      validators: { etag: state.etag, lastModified: state.lastModified },
    });
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state);
    log("warn", "form4 feed fetch failed", { error: String(e), failures: state.consecutiveFailures });
    return;
  }

  try {
    let entries: Form4FeedEntry[] = [];
    if (res.notModified) {
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
      await putSourceState(env.DB, state);
    } else if (!res.ok) {
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
      log("warn", "form4 feed non-2xx", { status: res.status, failures: state.consecutiveFailures });
      return;
    } else {
      entries = parseForm4Feed(res.body);
      if (entries.length === 0) {
        state.consecutiveFailures += 1;
        await putSourceState(env.DB, state);
        log("warn", "form4 feed parsed to zero entries; possible shape drift or maintenance page", {
          status: res.status,
          contentType: res.contentType,
          bodyPrefix: res.body.slice(0, 120),
          failures: state.consecutiveFailures,
        });
        return;
      }

      let inserted = 0;
      for (const entry of entries) {
        const fresh = isFreshAtIngest(entry.filedIso, now);
        // Amendments (4/A) are corrections — lake-only in the pilot, and we
        // skip their detail fetch entirely to conserve the request budget.
        const wantsDetail = entry.formType === "4" && fresh;
        const result = await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: entry.accession,
            category: "insider",
            eventAt: entry.filedIso || null,
            sourceUrl: entry.indexUrl,
            payload: { phase: "stub", formType: entry.formType, dirUrl: entry.dirUrl, attempts: 0 },
            score: SCORE_LOG_ONLY,
            status: wantsDetail ? "pending_detail" : "logged",
          },
          now,
        );
        if (result.outcome === "inserted") inserted += 1;
      }

      // Sliding-window overflow: same design as edgar_8k (verified paging).
      if (state.cursor && inserted === entries.length && !entries.some((e) => e.accession === state.cursor)) {
        log("error", "form4 possible window overflow; fetching page 2", { cursor: state.cursor });
        if (budget.take(1)) {
          try {
            const page2 = await politeFetch(FORM4_FEED_PAGE2, { userAgent, timeoutMs: 20_000 });
            if (page2.ok) {
              for (const entry of parseForm4Feed(page2.body)) {
                const fresh = isFreshAtIngest(entry.filedIso, now);
                await insertItem(
                  env.DB,
                  {
                    source: SOURCE,
                    externalId: entry.accession,
                    category: "insider",
                    eventAt: entry.filedIso || null,
                    sourceUrl: entry.indexUrl,
                    payload: { phase: "stub", formType: entry.formType, dirUrl: entry.dirUrl, attempts: 0 },
                    score: SCORE_LOG_ONLY,
                    status: entry.formType === "4" && fresh ? "pending_detail" : "logged",
                  },
                  now,
                );
              }
            }
          } catch (e) {
            log("warn", "form4 page 2 fetch failed", { error: String(e) });
          }
        }
      }

      state.etag = res.etag;
      state.lastModified = res.lastModified;
      state.cursor = entries[0]?.accession ?? state.cursor;
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
      await putSourceState(env.DB, state);
    }

    // Detail phase: 2 external fetches per stub, bounded by both the batch
    // cap and whatever the shared tick budget has left.
    const stubs = await env.DB.prepare(
      `SELECT id, event_at, payload FROM items
       WHERE source = ?1 AND status = 'pending_detail'
       ORDER BY id LIMIT ?2`,
    )
      .bind(SOURCE, DETAIL_BATCH_PER_RUN)
      .all<{ id: number; event_at: string | null; payload: string }>();

    let detailed = 0;
    for (const row of stubs.results) {
      if (!budget.take(2)) {
        log("warn", "tick budget exhausted; deferring form4 detail fetches", {
          remaining: stubs.results.length - detailed,
        });
        break;
      }
      await processDetail(env, row, userAgent, now);
      detailed += 1;
    }

    const enqueued = await drainPostables(env, now, budget);
    if (detailed > 0 || enqueued > 0) {
      log("info", "form4 poll", { detailed, enqueued });
    }
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    log("error", "form4 post-fetch processing failed", { error: String(e) });
  }
}
