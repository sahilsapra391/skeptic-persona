import type { Env } from "./env";
import { safeEqual } from "./telegram/webhook";
import { newTickBudget } from "./lib/budget";
import { insertItem, SCORE_LOG_ONLY, SCORE_POSTABLE } from "./lib/db";
import { parseAuctions, scoreAuction, draftAuction, SOURCE as TREASURY_SOURCE, TREASURY_PAGE } from "./ingesters/treasury";
import { parsePressFeed, PRESS_SOURCES, isNewsworthy, draftPress } from "./ingesters/regulatoryPress";
import { ingestEfdRow, parseEfdRows, SOURCE as SENATE_SOURCE, type EfdRow } from "./ingesters/senatePtr";
import { applyHousePtrText, SOURCE as HOUSE_SOURCE } from "./ingesters/housePtr";
import { enqueueForApproval } from "./pipeline/enqueue";
import { isFreshAtIngest } from "./ingesters/shared";
import { iso } from "./lib/time";
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
export const RELAY_SOURCES = new Set<string>([TREASURY_SOURCE, "press_cftc_enforcement", SENATE_SOURCE, HOUSE_SOURCE]);

/** GET this to learn which House PDFs still need extracting. */
export const PENDING_PATH = "/ingest/pending/house_ptr";

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
          : payload.source === HOUSE_SOURCE
            ? await ingestHouse(env, payload.body, now)
            : await ingestPress(env, payload.source, payload.body, now);
    const queued = await drain(env, payload.source, now);
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
    // the reason rather than a silent 200.
    log("error", "ingest relay parse failed", { source: payload.source, error: String(e) });
    return Response.json({ error: String(e) }, { status: 422 });
  }
}
