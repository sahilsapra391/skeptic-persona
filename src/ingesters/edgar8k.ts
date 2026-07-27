import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAll, extractAttr, extractFirst, stripBom } from "../lib/xml";
import {
  getSourceState,
  insertItem,
  putSourceState,
  SCORE_LOG_ONLY,
  SCORE_POSTABLE,
  type SourceState,
} from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Live-verified 2026-07-26, fixture-captured 2026-07-27T00:57Z, and
// count=100 + start-paging re-verified live 2026-07-27T02:26Z
// (docs/verification/): item numbers + official titles ride in each entry's
// <summary>, so acceptance -> items-known costs zero extra requests.
const FEED_BASE =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&output=atom";
export const EDGAR_8K_FEED = `${FEED_BASE}&count=100`;
export const EDGAR_8K_FEED_PAGE2 = `${FEED_BASE}&start=100&count=100`;

export const SOURCE = "edgar_8k";

/**
 * Editorial alert grades per 8-K item code (0 ignore / 1 log-only /
 * 2 postable / 3 auto-alert grade). Codes are the SEC's own; titles always
 * come from the feed itself, never from this table. Full current roster —
 * an unknown code here means the SEC added one (warn + log-only).
 */
export const ITEM_SCORES: Record<string, number> = {
  "1.01": 2, // material definitive agreement
  "1.02": 2, // termination of material agreement
  "1.03": 3, // bankruptcy or receivership
  "1.04": 1, // mine safety
  "1.05": 3, // material cybersecurity incident
  "2.01": 2, // completed acquisition/disposition
  "2.02": 2, // results of operations (earnings)
  "2.03": 1,
  "2.04": 2, // triggering events (defaults, acceleration)
  "2.05": 2, // exit/disposal costs (restructurings, layoffs)
  "2.06": 2, // material impairments
  "3.01": 2, // delisting / listing-standard notice
  "3.02": 1,
  "3.03": 1,
  "4.01": 2, // auditor change
  "4.02": 3, // non-reliance on prior financials (the accounting bombshell)
  "5.01": 3, // change in control
  "5.02": 3, // officer/director departures & appointments
  "5.03": 1,
  "5.04": 1, // benefit-plan trading blackout
  "5.05": 1, // code-of-ethics amendment/waiver
  "5.06": 2, // shell-status change
  "5.07": 1,
  "5.08": 1,
  "6.01": 1, // ABS informational
  "6.02": 1,
  "6.03": 1,
  "6.04": 1,
  "6.05": 1,
  "7.01": 1, // Reg FD disclosure
  "8.01": 1, // other events
  "9.01": 0, // exhibits only
};

export interface Edgar8kEntry {
  accession: string;
  company: string;
  cik: string;
  formType: string; // "8-K" | "8-K/A" | (prefix family, e.g. "8-K12B")
  indexUrl: string;
  filedIso: string; // <updated> (ET-offset) normalized to UTC ISO
  items: Array<{ code: string; title: string }>;
}

const TITLE_RE = /^(8-K(?:\/A)?) - (.+) \((\d{10})\) \(Filer\)$/;
const ACCESSION_RE = /accession-number=([0-9-]+)/;
const ITEM_RE = /Item (\d+\.\d+):\s*([^\n<]+)/g;

export function parse8kFeed(xml: string): Edgar8kEntry[] {
  const out: Edgar8kEntry[] = [];
  const seen = new Set<string>();
  for (const entry of extractAll(stripBom(xml), "entry")) {
    const accession = ACCESSION_RE.exec(extractFirst(entry, "id") ?? "")?.[1];
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);

    const title = decodeEntities(extractFirst(entry, "title") ?? "");
    const tm = TITLE_RE.exec(title);
    // category term is authoritative for the form type; getcurrent's type=
    // filter is PREFIX match (verified live), so 8-K12B/8-K12G3/8-K15D5 can
    // arrive here too. Those fail TITLE_RE -> cik stays "" -> scoreEntry
    // clamps them to log-only (a field that didn't parse is never claimed).
    const formType = extractAttr(entry, "category", "term") ?? tm?.[1] ?? "8-K";
    const company = tm?.[2] ?? title;
    const cik = tm?.[3] ?? "";
    const indexUrl = extractAttr(entry, "link", "href") ?? "";

    const updated = extractFirst(entry, "updated") ?? "";
    const filedAt = new Date(updated);
    const filedIso = Number.isNaN(filedAt.getTime()) ? "" : filedAt.toISOString();

    const summary = decodeEntities(extractFirst(entry, "summary") ?? "");
    const items: Array<{ code: string; title: string }> = [];
    let m: RegExpExecArray | null;
    ITEM_RE.lastIndex = 0;
    while ((m = ITEM_RE.exec(summary)) !== null) {
      items.push({ code: m[1] ?? "", title: (m[2] ?? "").trim() });
    }

    out.push({ accession, company, cik, formType, indexUrl, filedIso, items });
  }
  return out;
}

export function scoreEntry(entry: Edgar8kEntry): number {
  // No parsed items -> we can't say what the filing claims; log-only.
  if (entry.items.length === 0) return SCORE_LOG_ONLY;
  let score = 0;
  for (const item of entry.items) {
    const s = ITEM_SCORES[item.code];
    if (s === undefined) {
      // New/unknown SEC item code: surface loudly, never post unparsed claims.
      log("warn", "unknown 8-K item code", { code: item.code });
      score = Math.max(score, SCORE_LOG_ONLY);
    } else {
      score = Math.max(score, s);
    }
  }
  // Company/CIK failed to parse (e.g. an 8-K12x family title): fields that
  // didn't parse are never claimed in a draft.
  if (!entry.cik) score = Math.min(score, SCORE_LOG_ONLY);
  // Amendments correct earlier filings; posting them without the original's
  // context invites misreads. Pilot policy: log-only (covers 8-K/A and any
  // future 8-K12B/A style suffixes).
  if (entry.formType.endsWith("/A")) score = Math.min(score, SCORE_LOG_ONLY);
  return score;
}

/** Tier A draft: purely parsed fields (form type, company, the SEC's own item titles). */
export function draftFor(entry: Edgar8kEntry): string {
  const substantive = entry.items.filter((i) => i.code !== "9.01");
  const shown = substantive.length > 0 ? substantive : entry.items;
  const head = `${entry.formType}: ${entry.company}`;
  return [head, ...shown.map((i) => `Item ${i.code}: ${i.title}`)].join("\n");
}

/** Cap Telegram notifications per run: external fetches share the 50/invocation budget. */
export const MAX_ENQUEUES_PER_RUN = 10;

export { isFreshAtIngest, STALE_AT_INGEST_HOURS } from "./shared";
import { isFreshAtIngest } from "./shared";

async function ingestEntries(env: Env, entries: Edgar8kEntry[], now: Date): Promise<number> {
  let inserted = 0;
  for (const entry of entries) {
    const score = scoreEntry(entry);
    const result = await insertItem(
      env.DB,
      {
        source: SOURCE,
        externalId: entry.accession,
        category: "filing",
        eventAt: entry.filedIso || null,
        sourceUrl: entry.indexUrl,
        payload: {
          company: entry.company,
          cik: entry.cik,
          formType: entry.formType,
          items: entry.items,
          // Flat code list so gates can test membership declaratively.
          itemCodes: entry.items.map((i) => i.code),
        },
        score,
        // Sub-postable AND stale-at-ingest items go straight to 'logged' so
        // the notify-drain's 'new' set stays small (D1 rows-read discipline)
        // and the queue only ever carries actual news.
        status: score >= SCORE_POSTABLE && isFreshAtIngest(entry.filedIso, now) ? "new" : "logged",
      },
      now,
    );
    if (result.outcome === "inserted") inserted += 1;
  }
  return inserted;
}

/** Notify postable items ('new' = not yet queued), paced for Telegram flood control. */
async function drainPostables(env: Env, now: Date, budget: TickBudget): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items
     WHERE source = ?1 AND status = 'new' AND score >= ?2
     ORDER BY id LIMIT ?3`,
  )
    .bind(SOURCE, SCORE_POSTABLE, MAX_ENQUEUES_PER_RUN)
    .all<{ id: number; source_url: string; payload: string }>();

  const spacingRaw = Number(env.QUEUE_NOTIFY_SPACING_MS ?? 1100);
  const spacingMs = Number.isFinite(spacingRaw) && spacingRaw >= 0 ? spacingRaw : 1100;

  let sent = 0;
  for (const row of pending.results) {
    if (!budget.take(1)) {
      log("warn", "tick budget exhausted; deferring remaining notifications", { remaining: pending.results.length - sent });
      break;
    }
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "FILING_8K", payload, row.source_url, now);
    sent += 1;
    if (result.retryAfter !== null) {
      // Telegram flood control: stop batching; the rest are still 'new' and
      // the next poll picks them up.
      log("warn", "telegram flood control; deferring remaining notifications", { retryAfter: result.retryAfter });
      break;
    }
    if (spacingMs > 0 && sent < pending.results.length) {
      await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
  }
  return sent;
}

async function markUnhealthy(env: Env, state: SourceState, reason: string, fields: Record<string, unknown>): Promise<void> {
  state.consecutiveFailures += 1;
  await putSourceState(env.DB, state);
  log("warn", reason, { ...fields, failures: state.consecutiveFailures });
}

export async function pollEdgar8k(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);

  if (!budget.take(1)) {
    log("warn", "tick budget exhausted before edgar_8k feed fetch; deferring poll");
    return;
  }
  let res;
  try {
    res = await politeFetch(EDGAR_8K_FEED, {
      userAgent,
      timeoutMs: 20_000,
      validators: { etag: state.etag, lastModified: state.lastModified },
    });
  } catch (e) {
    await markUnhealthy(env, state, "edgar_8k feed fetch failed", { error: String(e) });
    return;
  }

  try {
    if (res.notModified) {
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
      await putSourceState(env.DB, state);
      // Leftover postables from a capped earlier run still deserve notifying.
      await drainPostables(env, now, budget);
      return;
    }
    if (!res.ok) {
      await markUnhealthy(env, state, "edgar_8k feed non-2xx", { status: res.status });
      return;
    }

    const entries = parse8kFeed(res.body);
    if (entries.length === 0) {
      // getcurrent is a rolling latest-N list; it carries entries even on a
      // dead weekend. Zero entries on a 200 means shape drift or a
      // maintenance page — do NOT store its validators or refresh lastOkAt.
      await markUnhealthy(env, state, "edgar_8k feed parsed to zero entries; possible shape drift or maintenance page", {
        status: res.status,
        contentType: res.contentType,
        bodyPrefix: res.body.slice(0, 120),
      });
      return;
    }

    let inserted = await ingestEntries(env, entries, now);

    // Sliding-window overflow check: if the previous poll's newest accession
    // is no longer on page 1 AND everything on page 1 was new to us, filings
    // may have scrolled past. Fetch one bounded second page (start-paging
    // verified live 2026-07-27T02:26Z).
    if (state.cursor && inserted === entries.length && !entries.some((e) => e.accession === state.cursor)) {
      log("error", "edgar_8k possible window overflow; fetching page 2", { cursor: state.cursor, pageSize: entries.length });
      if (budget.take(1)) {
        try {
          const page2 = await politeFetch(EDGAR_8K_FEED_PAGE2, { userAgent, timeoutMs: 20_000 });
          if (page2.ok) inserted += await ingestEntries(env, parse8kFeed(page2.body), now);
        } catch (e) {
          log("warn", "edgar_8k page 2 fetch failed", { error: String(e) });
        }
      }
    }

    const enqueued = await drainPostables(env, now, budget);

    state.etag = res.etag;
    state.lastModified = res.lastModified;
    state.cursor = entries[0]?.accession ?? state.cursor;
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);

    if (inserted > 0 || enqueued > 0) {
      log("info", "edgar_8k poll", { inserted, enqueued });
    }
  } catch (e) {
    // D1-phase failure after a successful fetch: the health signal must not
    // stay green (validators/cursor intentionally not updated so the next
    // poll re-reads the same feed; dedup makes the replay harmless).
    await markUnhealthy(env, state, "edgar_8k post-fetch processing failed", { error: String(e) }).catch(() => {});
  }
}
