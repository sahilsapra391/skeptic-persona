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
import { lookbackFieldsFor, recordFacts } from "../lookback";
import { resolveSymbol } from "../lib/symbol";
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

/**
 * Item codes that reach the approval queue. Everything else lands in the lake.
 *
 * WHY THIS IS A SHORT LIST (owner call 2026-07-27): the queue hit 102 pending
 * drafts, 84 of them 8-Ks and 42 of THOSE earnings releases. Two independent
 * findings say earnings are the wrong volume to carry: they underperform in
 * every competitor account measured (unusual_whales runs them at 0.49x, one
 * of its three worst formats), and we cannot post the beat/miss comparison
 * that makes an earnings item work at all, because consensus estimates have
 * no free primary source. persona.md §7: selection is where the worldview
 * lives, so the wire queues the filings it exists for and logs the rest.
 */
export const QUEUEABLE_ITEMS = new Set(["1.03", "1.05", "4.02", "5.01", "5.02", "3.01", "2.04", "2.06"]);

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
  // SELECTION GATE: a filing whose items are all outside the queueable set
  // is lake-only regardless of its grade. This is editorial, not technical —
  // the data is still captured, it just does not ask for the owner's
  // attention or a slot on the account.
  if (!entry.items.some((i) => QUEUEABLE_ITEMS.has(i.code))) {
    score = Math.min(score, SCORE_LOG_ONLY);
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

// draftFor() DELETED (B-21.5). It was test-only: production builds the 8-K
// card from `payload.company` and `payload.items` through the FILING_8K
// skeletons in src/templates/archetypes.ts, and nothing in src/ ever called
// this. Its two assertions -- the head uses the PARSED form type, and 9.01 is
// dropped as exhibit noise unless it is the only item -- were real rules
// tested against a dead copy while the live implementation in archetypes.ts
// had no coverage at all. Both moved to test/templates.test.ts, against the
// code that actually runs. That is the D-71 family: a test asserting
// behaviour production never executes.

/** Cap Telegram notifications per run: external fetches share the 50/invocation budget. */
export const MAX_ENQUEUES_PER_RUN = 10;

export { isFreshAtIngest, STALE_AT_INGEST_HOURS } from "./shared";
import { isFreshAtIngest } from "./shared";
import { archetypeForItems, buildEarningsPayload, issuerFor } from "../pipeline/earnings";
import { keepIssuer, lookupIssuer, minFloatUsd, referenceHealth, referenceIsAuthoritative } from "./issuers";

/** Test seam: drive the real ingest path with hand-built entries. */
export function ingestForTest(env: Env, entries: Edgar8kEntry[], now: Date = new Date()): Promise<number> {
  return ingestEntries(env, entries, now);
}

async function ingestEntries(env: Env, entries: Edgar8kEntry[], now: Date): Promise<number> {
  let inserted = 0;
  const floor = minFloatUsd(env);
  // Read the reference health ONCE per batch, not per filing.
  const authoritative = referenceIsAuthoritative(await referenceHealth(env), now);
  for (const entry of entries) {
    let score = scoreEntry(entry);

    // ISSUER GATE. EDGAR's filer universe is mostly funds, trusts and shells;
    // measured on 2026-07-28, 17% of live 8-K items came from filers with no
    // listing at all and another 29% from issuers under the float floor.
    // Those filings still land in the lake, they just stop interrupting.
    //
    // Fails OPEN: an issuer we cannot find has not been shown to be small.
    const issuerRow = await lookupIssuer(env, entry.cik);
    const gate = keepIssuer(issuerRow, floor, authoritative);
    // Same row the gate just read; no second query.
    const symbol = await resolveSymbol(env, {
      cik: entry.cik,
      issuerName: entry.company,
      issuer: issuerRow,
    });
    if (!gate.keep) {
      score = Math.min(score, SCORE_LOG_ONLY);
      log("debug", "8-K suppressed by issuer gate", { cik: entry.cik, company: entry.company, reason: gate.reason });
    }
    const result = await insertItem(
      env.DB,
      {
        source: SOURCE,
        externalId: entry.accession,
        category: "filing",
        eventAt: entry.filedIso || null,
        sourceUrl: entry.indexUrl,
        payload: {
          // `company` is what templates, beats and prompts print, so it
          // carries the resolved label; the filed name keeps its own key.
          company: symbol.label,
          companyFiled: entry.company,
          ticker: symbol.ticker,
          tickerSource: symbol.source,
          ...(symbol.ambiguity ? { tickerAmbiguity: symbol.ambiguity } : {}),
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

    // Record one fact per item code so "second non-reliance this year" is a
    // QUERY, never an assumption. Keyed on CIK: company names vary by filing
    // agent, CIKs do not. Unparsed CIK -> no facts, so the beat cannot fire.
    if (result.outcome === "inserted" && result.id !== null && entry.cik && entry.filedIso) {
      await recordFacts(
        env.DB,
        entry.items.map((i) => ({
          itemId: result.id as number,
          source: SOURCE,
          entity: entry.cik,
          metric: `8k.item.${i.code}`,
          occurredAt: entry.filedIso,
        })),
        now,
      );
    }
  }
  return inserted;
}

/** Notify postable items ('new' = not yet queued), paced for Telegram flood control. */
async function drainPostables(env: Env, now: Date, budget: TickBudget): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload, event_at FROM items
     WHERE source = ?1 AND status = 'new' AND score >= ?2
     ORDER BY id LIMIT ?3`,
  )
    .bind(SOURCE, SCORE_POSTABLE, MAX_ENQUEUES_PER_RUN)
    .all<{ id: number; source_url: string; payload: string; event_at: string | null }>();


  let sent = 0;
  for (const row of pending.results) {
    if (!budget.take(1)) {
      log("warn", "tick budget exhausted; deferring remaining notifications", { remaining: pending.results.length - sent });
      break;
    }
    const payload = JSON.parse(row.payload) as Record<string, unknown>;

    // Lookback fields are computed at ENQUEUE time against the lake as it
    // stands, so an approved draft's claim matches what was true when the
    // owner saw it.
    const cik = typeof payload.cik === "string" ? payload.cik : "";
    const codes = Array.isArray(payload.itemCodes) ? (payload.itemCodes as string[]) : [];
    const headline = codes.find((c) => c === "4.02") ?? codes.find((c) => c !== "9.01") ?? null;
    if (cik && headline) {
      const yearStart = `${now.getUTCFullYear()}-01-01T00:00:00.000Z`;
      const fields = await lookbackFieldsFor(env.DB, {
        source: SOURCE,
        entity: cik,
        metric: `8k.item.${headline}`,
        since: yearStart,
        itemId: row.id,
      });
      // THE COVERAGE GUARD (owner instruction 2026-08-06). An occurrence
      // count is a claim about a WINDOW, and it is only licensed when our
      // source coverage predates that window. If we started observing
      // edgar_8k in July, "filing number 3 of this item this year" is not a
      // fact we hold — we cannot see January to June, and the true count may
      // be higher.
      //
      // OMITTED, not shrunk, exactly like every other pattern field: the
      // fields simply do not appear on the payload, so the gates
      // (`gte sameItemOccurrence 3`, `eq sameItemOccurrence 2`) cannot match
      // and no beat can state a count. Coverage always rides along so the
      // ledger records why.
      const windowDays = Math.ceil((now.getTime() - Date.parse(yearStart)) / 86_400_000);
      const covered = fields.coverageDays !== null && fields.coverageDays >= windowDays;
      payload.lookbackCoverageDays = fields.coverageDays;
      payload.lookbackWindowDays = windowDays;
      if (covered) {
        payload.priorSameItemThisYear = fields.priorCount;
        payload.sameItemOccurrence = fields.occurrence;
      } else {
        log("info", "occurrence claim omitted: coverage shorter than the window", {
          itemId: row.id,
          coverageDays: fields.coverageDays,
          windowDays,
        });
      }
    }

    // ROUTING (p5-20). An item-2.02 filing is an EARNINGS EVENT, not a
    // generic 8-K, and gets a payload that carries no earnings figure at all.
    // 4.02 outranks 2.02: a filing that both reports results and disclaims
    // prior financials is a non-reliance story.
    const archetype = archetypeForItems(codes);
    let outbound = payload;
    if (archetype === "EARNINGS_EVENT") {
      const filedIso = typeof payload.filedIso === "string" ? payload.filedIso : (row.event_at ?? "");
      outbound = buildEarningsPayload({
        company: typeof payload.company === "string" ? payload.company : "",
        cik,
        formType: typeof payload.formType === "string" ? payload.formType : "8-K",
        filedIso,
        periodIso: typeof payload.periodIso === "string" ? payload.periodIso : null,
        issuer: await issuerFor(env.DB, cik),
        sameItemOccurrence: typeof payload.sameItemOccurrence === "number" ? payload.sameItemOccurrence : undefined,
        priorSameItemThisYear: typeof payload.priorSameItemThisYear === "number" ? payload.priorSameItemThisYear : undefined,
        lookbackCoverageDays: typeof payload.lookbackCoverageDays === "number" ? payload.lookbackCoverageDays : undefined,
      });
    }
    const result = await enqueueForApproval(env, row.id, archetype, outbound, row.source_url, now);
    sent += 1;
    if (result.retryAfter !== null) {
      // Telegram flood control: stop batching; the rest are still 'new' and
      // the next poll picks them up.
      log("warn", "telegram flood control; deferring remaining notifications", { retryAfter: result.retryAfter });
      break;
    }
    // Pacing moved to sendMessage (per-CHAT, not per-job). A sleep here paced
    // this loop against itself; with concurrent jobs nothing paced the chat.
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
