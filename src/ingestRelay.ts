import type { Env } from "./env";
import { safeEqual } from "./telegram/webhook";
import { newTickBudget } from "./lib/budget";
import { insertItem, SCORE_LOG_ONLY, SCORE_POSTABLE } from "./lib/db";
import { parseAuctions, scoreAuction, draftAuction, SOURCE as TREASURY_SOURCE, TREASURY_PAGE } from "./ingesters/treasury";
import { parsePressFeed, PRESS_SOURCES, isNewsworthy, draftPress } from "./ingesters/regulatoryPress";
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
export const RELAY_SOURCES = new Set<string>([TREASURY_SOURCE, "press_cftc_enforcement"]);

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
async function drain(env: Env, source: string, now: Date): Promise<number> {
  const budget = newTickBudget();
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items
     WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 3`,
  )
    .bind(source, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  let sent = 0;
  const archetype = source === TREASURY_SOURCE ? "TREASURY_AUCTION" : "REGULATORY_NEWS";
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, archetype, payload, row.source_url, now);
    sent += 1;
    if (result.retryAfter !== null) break;
  }
  return sent;
}

export async function handleIngestRelay(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
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
