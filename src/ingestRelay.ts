import type { Env } from "./env";
import { safeEqual } from "./telegram/webhook";
import { newTickBudget } from "./lib/budget";
import {
  getSourceState,
  insertItem,
  putSourceState,
  recordSourceError,
  SCORE_LOG_ONLY,
  SCORE_POSTABLE,
} from "./lib/db";
import { parseAuctions, scoreAuction, draftAuction, SOURCE as TREASURY_SOURCE, TREASURY_PAGE } from "./ingesters/treasury";
import { parsePressFeed, PRESS_SOURCES, isNewsworthy, draftPress } from "./ingesters/regulatoryPress";
import { ingestEfdRow, parseEfdRows, SOURCE as SENATE_SOURCE, type EfdRow } from "./ingesters/senatePtr";
import { applyHousePtrText, SOURCE as HOUSE_SOURCE } from "./ingesters/housePtr";
import { enqueueForApproval } from "./pipeline/enqueue";
import { isFreshAtIngest } from "./ingesters/shared";
import { iso } from "./lib/time";
import { parseAndStore13f } from "./ingesters/form13f";
import { runDiffFor } from "./ingesters/form13fDiff";
import { scrubUrls } from "./lib/html";
import { log } from "./lib/log";

// INGEST RELAY.
//
// Five sources are unreachable from Cloudflare Worker egress, each failing a
// different way: Senate eFD 403s datacenter IPs, NSE India resets on our
// declared UA, treasury.gov fails TLS (525) on two hosts, and www.cftc.gov
// 403s. All five answer normally from a residential-class connection.
//
// So the FETCH moves to GitHub Actions and everything else stays here. The
// Action is a dumb courier: it fetches the bytes and POSTs them to this
// endpoint. Parsing, scoring, drafting, dedup and the approval queue all run
// on the code already written and already tested — no logic is duplicated in
// CI, which is the failure mode this design exists to avoid.
export const INGEST_PATH = "/ingest";

export interface RelayPayload {
  source: string;
  /** Raw body exactly as the origin served it. */
  body: string;
  /** When the courier fetched it, ISO UTC. */
  fetchedAt?: string;
}

/** Sources this relay knows how to ingest. Anything else is rejected. */

/** GET this to learn which House PDFs still need extracting. */
export const PENDING_PATH = "/ingest/pending/house_ptr";

/** Press releases whose body is a PDF the Worker cannot read. */
export const PRESS_PENDING_PATH = "/ingest/pending/press_pdf";
export const PRESS_BODY_SOURCE = "press_body";

/**
 * Press feeds whose items link to PDFs rather than pages.
 *
 * Measured 2026-08-01 by fetching every item in all six press feeds: three
 * ship a usable RSS description and p4-01 captures those at ingest. Of the
 * three that ship none, two link to PDFs --
 *
 *   press_sec_enforcement   25 of 25 items are .pdf
 *   press_boj               16 of 43 (the rest are HTML the fallback reads)
 *
 * -- and press_cftc_enforcement is unreachable from Worker egress anyway
 * (403, verified 2026-07-27), so it is deliberately absent.
 *
 * A PDF cannot be grounded in the Worker: htmlToText yields object tables and
 * byte offsets, which looksBinary now refuses precisely because those digits
 * would otherwise license themselves into a post.
 */
export const PRESS_PDF_SOURCES = ["press_sec_enforcement", "press_boj"] as const;

export const THIRTEENF_BACKFILL_SOURCE = "13f_backfill";
export const RELAY_SOURCES = new Set<string>([
  TREASURY_SOURCE,
  "press_cftc_enforcement",
  SENATE_SOURCE,
  HOUSE_SOURCE,
  PRESS_BODY_SOURCE,
  THIRTEENF_BACKFILL_SOURCE,
]);

/** Bounded so one run cannot spend an hour of Actions time on a backlog. */
// 285 e-filed documents were waiting when this shipped, mostly historical.
// They land as 'logged' (stale-at-ingest) and enrich the lake the lookback
// engine reads, so clearing the backlog has real value. 50 sequential
// downloads at 1 req/s is ~1 minute against a 15-minute job budget, and
// keeps the same polite spacing.
const PENDING_LIMIT = 50;

/**
 * Give up after this many extraction attempts on one document. Without a
 * cap a scanned PDF that will NEVER yield text is re-downloaded every day
 * forever. Raising the cap (or clearing pdfAttempts) re-enables a document
 * after a parser fix.
 */
const MAX_PDF_ATTEMPTS = 3;

/**
 * Senate eFD needs THREE things the Worker cannot fetch: a session handshake,
 * the search POST, and one detail page per filing. So the courier does all of
 * it and delivers a bundle — the search JSON plus a map of uuid -> detail
 * HTML. Everything after that is the same code the direct poller runs.
 */
export interface SenateBundle {
  search: unknown;
  details: Record<string, string>;
}

async function ingestSenate(env: Env, body: string, now: Date): Promise<number> {
  const bundle = JSON.parse(body) as SenateBundle;
  const rows: EfdRow[] = parseEfdRows(bundle.search);
  if (rows.length === 0) throw new Error("senate bundle: search parsed to zero rows");
  const details = bundle.details ?? {};

  let inserted = 0;
  for (const row of rows) {
    // A missing detail page is SKIPPED, not guessed at: the courier may have
    // been rate-limited mid-run, and an item inserted without its
    // transactions would look complete while claiming nothing.
    const html = row.kind === "paper" ? null : (details[row.uuid] ?? null);
    if (row.kind !== "paper" && html === null) continue;
    const outcome = await ingestEfdRow(env, row, html, now);
    if (outcome === "inserted") inserted += 1;
  }
  return inserted;
}

async function ingestTreasury(env: Env, body: string, now: Date): Promise<number> {
  const auctions = parseAuctions(body);
  let inserted = 0;
  for (const a of auctions) {
    const score = scoreAuction(a);
    const fresh = a.auctionDate >= now.toISOString().slice(0, 10);
    const res = await insertItem(
      env.DB,
      {
        source: TREASURY_SOURCE,
        externalId: `${a.cusip}:${a.auctionDate}`,
        category: "auction",
        eventAt: `${a.auctionDate}T00:00:00.000Z`,
        sourceUrl: TREASURY_PAGE,
        payload: { ...a, factLine: draftAuction(a) },
        score,
        status: score >= SCORE_POSTABLE && fresh ? "new" : "logged",
      },
      now,
    );
    if (res.outcome === "inserted") inserted += 1;
  }
  return inserted;
}

async function ingestPress(env: Env, sourceId: string, body: string, now: Date): Promise<number> {
  const src = PRESS_SOURCES.find((s) => s.id === sourceId);
  if (!src) return 0;
  const items = parsePressFeed(body);
  let inserted = 0;
  for (const item of items) {
    const newsworthy = isNewsworthy(src, item);
    const score = newsworthy ? SCORE_POSTABLE : SCORE_LOG_ONLY;
    const res = await insertItem(
      env.DB,
      {
        source: src.id,
        externalId: item.guid,
        category: "regulatory",
        eventAt: item.publishedIso,
        sourceUrl: item.link,
        payload: {
          authority: src.authority,
          title: item.title,
          categories: item.categories,
          publishedIso: item.publishedIso,
          factLine: draftPress(src, item),
        },
        score,
        status: score >= SCORE_POSTABLE && isFreshAtIngest(item.publishedIso, now) ? "new" : "logged",
        rawText: item.description,
        // parsePressFeed builds the payload AND the description from the same
        // <item>/<entry> block, with no fetch in between.
        rawTextMode: "same_entry" as const,
      },
      now,
    );
    if (res.outcome === "inserted") inserted += 1;
  }
  return inserted;
}

/**
 * Drain whatever the relay just made postable. Deliberately capped low: a
 * courier delivering a backlog must not fire twenty Telegram cards at once.
 */
/**
 * Documents the courier should fetch: House PTRs we indexed from the ZIP but
 * whose transactions we have never read.
 *
 * Returns the source_url we already stored rather than a docId the courier
 * would rebuild a URL from — one URL construction, in the ingester, tested.
 */
export async function handleIngestPending(request: Request, env: Env): Promise<Response> {
  const denied = authFailure(request, env);
  if (denied) return denied;

  const rows = await env.DB.prepare(
    `SELECT external_id AS docId, source_url AS url FROM items
      WHERE source = ?1
        AND json_valid(payload)
        AND json_extract(payload, '$.transactions') IS NULL
        AND json_extract(payload, '$.efiled') = 1
        AND COALESCE(json_extract(payload, '$.pdfAttempts'), 0) < ?2
      ORDER BY id DESC LIMIT ?3`,
  )
    .bind(HOUSE_SOURCE, MAX_PDF_ATTEMPTS, PENDING_LIMIT)
    .all<{ docId: string; url: string }>();

  return Response.json({ docs: rows.results });
}

/**
 * Press items still needing a body: no raw_text, and a source_url that is
 * plainly a PDF.
 *
 * Keyed on item id rather than a URL the courier would reconstruct, and the
 * URL comes from the row, so there is exactly one place a press URL is built
 * and it is the ingester that already parsed it.
 */
export async function handlePressPending(request: Request, env: Env): Promise<Response> {
  const denied = authFailure(request, env);
  if (denied) return denied;

  const placeholders = PRESS_PDF_SOURCES.map((_, i) => `?${i + 1}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT id, source_url AS url FROM items
      WHERE source IN (${placeholders})
        AND raw_text IS NULL
        AND lower(source_url) LIKE '%.pdf'
      ORDER BY id DESC LIMIT ?${PRESS_PDF_SOURCES.length + 1}`,
  )
    .bind(...PRESS_PDF_SOURCES, PENDING_LIMIT)
    .all<{ id: number; url: string }>();

  return Response.json({ docs: rows.results });
}

interface PressBody {
  id: number;
  text: string;
}

/**
 * Store courier-extracted press PDF text as grounding.
 *
 * The courier sends TEXT, never bytes, so nothing binary reaches raw_text by
 * this path. Empty text is recorded as an attempt rather than stored: a scan
 * with no text layer must not look like a document we read and found blank.
 */
async function ingestPressBodies(env: Env, body: string, now: Date): Promise<number> {
  const parsed = JSON.parse(body) as { docs?: unknown };
  if (!Array.isArray(parsed.docs)) throw new Error("press_body: body has no docs array");

  let stored = 0;
  for (const raw of parsed.docs) {
    const doc = raw as Partial<PressBody>;
    if (typeof doc?.id !== "number" || typeof doc?.text !== "string") {
      throw new Error("press_body: doc missing id or text");
    }
    const text = scrubUrls(doc.text.replace(/\u0000/g, "")).trim().slice(0, PRESS_BODY_CAP);
    if (text.length === 0) {
      log("info", "press body extraction produced no text", { itemId: doc.id });
      continue;
    }
    // Only fills a hole. A row that already has grounding text -- from an RSS
    // description or an earlier run -- is never overwritten by a later
    // courier pass.
    const res = await env.DB.prepare(
      `UPDATE items SET raw_text = ?1, raw_meta = ?2 WHERE id = ?3 AND raw_text IS NULL`,
    )
      .bind(
        text,
        JSON.stringify({
          mode: "full",
          fetchedAt: iso(now),
          bytes: doc.text.length,
          truncated: doc.text.length > PRESS_BODY_CAP,
          // Same provenance marker the other dedicated captures write: a
          // field the generation fallback cannot produce, because it never
          // ran a PDF extractor.
          document: "courier-pdf",
        }),
        doc.id,
      )
      .run();
    if ((res.meta.changes ?? 0) > 0) stored += 1;
  }
  return stored;
}

/** Same ceiling every other full-mode grounding write obeys. */
const PRESS_BODY_CAP = 24_000;

interface HouseDoc {
  docId: string;
  text: string;
}

/**
 * Apply extracted PDF text to the matching House items.
 *
 * The courier sends text; every judgement about it (completeness, scoring,
 * drafting) happens here, on the code the tests cover.
 */
async function ingestHouse(env: Env, body: string, now: Date): Promise<number> {
  const parsed = JSON.parse(body) as { docs?: unknown };
  if (!Array.isArray(parsed.docs)) throw new Error("house_ptr: body has no docs array");

  let applied = 0;
  for (const raw of parsed.docs) {
    const doc = raw as Partial<HouseDoc>;
    if (typeof doc?.docId !== "string" || typeof doc?.text !== "string") {
      throw new Error("house_ptr: doc missing docId or text");
    }
    const outcome = await applyHousePtrText(env, doc.docId, doc.text, now);
    if (outcome.status === "queued" || outcome.status === "logged") {
      applied += 1;
      continue;
    }
    // Every non-apply is counted so a document that can never yield text
    // stops being fetched. Counting happens HERE, not in the parser, because
    // "we tried and failed" is relay state, not a property of the text.
    await env.DB.prepare(
      `UPDATE items
          SET payload = json_set(payload, '$.pdfAttempts', COALESCE(json_extract(payload, '$.pdfAttempts'), 0) + 1,
                                          '$.pdfLastFailure', ?2)
        WHERE source = ?1 AND external_id = ?3 AND json_valid(payload)`,
    )
      .bind(HOUSE_SOURCE, outcome.status, doc.docId)
      .run();
    log("warn", "house_ptr extraction not applied", { docId: doc.docId, outcome: outcome.status });
  }
  return applied;
}

async function drain(env: Env, source: string, now: Date): Promise<number> {
  const budget = newTickBudget();
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items
     WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 3`,
  )
    .bind(source, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  let sent = 0;
  const archetype =
    source === TREASURY_SOURCE
      ? "TREASURY_AUCTION"
      : source === SENATE_SOURCE || source === HOUSE_SOURCE
        ? "CONGRESS_PTR"
        : "REGULATORY_NEWS";
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, archetype, payload, row.source_url, now);
    sent += 1;
    if (result.retryAfter !== null) break;
  }
  return sent;
}

/**
 * One auth check for every relay endpoint. Returns a Response to send, or
 * null to proceed. Shared so a new endpoint cannot accidentally ship without
 * the timing-safe compare.
 */
function authFailure(request: Request, env: Env): Response | null {
  const secret = env.INGEST_SECRET;
  if (!secret) {
    log("warn", "ingest relay hit but INGEST_SECRET is not configured");
    return new Response("not configured", { status: 503 });
  }
  const presented = request.headers.get("X-Ingest-Secret");
  // Timing-safe, and a missing header fails before any body is read.
  if (!presented || !safeEqual(presented, secret)) {
    log("warn", "ingest relay auth failure");
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

/**
 * 13F-03 backfill lane. The courier is dumb by design: it fetches a filing's
 * primary_doc + infotable bytes from EDGAR and forwards them untouched; ALL
 * parsing happens here through parseAndStore13f — the same single
 * implementation the live poll uses. The courier's period judgement is
 * irrelevant: the Worker stores what primary_doc itself says.
 */
async function ingest13fBackfill(env: Env, body: string, now: Date): Promise<number> {
  let doc: { cik?: string; accession?: string; form?: string; filed_at?: string; primary_doc?: string; infotable?: string };
  try {
    doc = JSON.parse(body) as typeof doc;
  } catch {
    throw new Error("13f_backfill body is not JSON");
  }
  const { cik, accession, form, filed_at: filedAt, primary_doc: primaryDoc, infotable } = doc;
  if (!cik || !accession || !form || !filedAt || !primaryDoc || !infotable) {
    throw new Error("13f_backfill missing fields");
  }
  if (!/^13F-HR(\/A)?$/.test(form)) throw new Error(`13f_backfill rejects form ${form}`);

  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO filings_13f (accession, cik, manager_name, form, filed_at, status, created_at)
     SELECT ?1, ?2, COALESCE((SELECT name FROM managers_13f WHERE cik = ?2), ?2), ?3, ?4, 'pending_parse', ?5`,
  )
    .bind(accession, cik, form, filedAt, iso(now))
    .run();
  const row = await env.DB.prepare(`SELECT id, status FROM filings_13f WHERE accession = ?1`)
    .bind(accession)
    .first<{ id: number; status: string }>();
  if (!row) throw new Error("13f_backfill insert failed");
  // Re-POSTing an already-parsed filing is a no-op, not a re-parse: the
  // courier retries freely and the record cannot be double-written.
  if (row.status === "parsed" || row.status === "quarantined") return 0;

  await parseAndStore13f(env, { id: row.id, cik, accession }, primaryDoc, infotable, infotable.length, now);
  await runDiffFor(env, cik, now);
  return (ins.meta.changes ?? 0) > 0 ? 1 : 0;
}

export async function handleIngestRelay(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const denied = authFailure(request, env);
  if (denied) return denied;

  let payload: RelayPayload;
  try {
    payload = await request.json<RelayPayload>();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (typeof payload?.source !== "string" || typeof payload?.body !== "string") {
    return new Response("bad request", { status: 400 });
  }
  if (!RELAY_SOURCES.has(payload.source)) {
    // An unknown source is a deploy mismatch between the courier and here.
    log("warn", "ingest relay rejected unknown source", { source: payload.source });
    return Response.json({ error: "unknown source" }, { status: 400 });
  }
  if (payload.body.length === 0) {
    return Response.json({ error: "empty body" }, { status: 400 });
  }

  try {
    const inserted =
      payload.source === TREASURY_SOURCE
        ? await ingestTreasury(env, payload.body, now)
        : payload.source === SENATE_SOURCE
          ? await ingestSenate(env, payload.body, now)
          : payload.source === PRESS_BODY_SOURCE
            ? await ingestPressBodies(env, payload.body, now)
            : payload.source === HOUSE_SOURCE
              ? await ingestHouse(env, payload.body, now)
            : payload.source === THIRTEENF_BACKFILL_SOURCE
              ? await ingest13fBackfill(env, payload.body, now)
            : await ingestPress(env, payload.source, payload.body, now);
    const queued = await drain(env, payload.source, now);

    // RECORD THE HEALTH OF A RELAYED SOURCE (D-71). Until now this handler
    // inserted rows and drained without ever touching `source_state`, so a
    // source that is fed by the courier had no health record at all — its row
    // held whatever the last DIRECT poll left behind, forever.
    //
    // That is not cosmetic. On 2026-08-07 the senate row still read
    // `consecutive_failures=5, last_error="efd home 403", last_ok=08-02` while
    // 18 filings were landing through this exact code path, and that stale row
    // is what the previous diagnosis was built on. A health table that reports
    // a five-day-old error during a successful ingest is worse than no table.
    const state = await getSourceState(env.DB, payload.source);
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state).catch(() => {});

    log("info", "ingest relay accepted", {
      source: payload.source,
      bytes: payload.body.length,
      inserted,
      queued,
      fetchedAt: payload.fetchedAt ?? iso(now),
    });
    return Response.json({ ok: true, inserted, queued });
  } catch (e) {
    // A parse failure is the courier's problem to see, so it gets a 422 with
    // the reason rather than a silent 200. It is also the source's problem:
    // recorded here so a courier-fed source can go unhealthy in the table
    // rather than only in the workflow log.
    //
    // The increment is done here rather than inside recordSourceError because
    // that helper only writes last_error/last_error_at; every existing caller
    // bumps the counter itself first (see pollPrWire). Matching the convention
    // instead of changing a helper five ingesters already depend on.
    await (async () => {
      const state = await getSourceState(env.DB, payload.source);
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
    })().catch(() => {});
    await recordSourceError(env.DB, payload.source, e, now).catch(() => {});
    log("error", "ingest relay parse failed", { source: payload.source, error: String(e) });
    return Response.json({ error: String(e) }, { status: 422 });
  }
}
