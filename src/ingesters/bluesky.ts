import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_LOG_ONLY } from "../lib/db";
import { iso } from "../lib/time";
import { log } from "../lib/log";

/**
 * Bluesky discovery lane (p5-25, B-03.6).
 *
 * SHIPPED BEHIND `BLUESKY_ENABLED`, DEFAULT OFF. The lane is complete and
 * tested; it does nothing in production until the flag is set, which is the
 * shape B-03.6 asked for.
 *
 * THESE ITEMS CAN NEVER BECOME A POST, by construction rather than by policy.
 * The p4 mesh rule is unambiguous:
 *
 *   "Social and news items are DISCOVERY, never citation. A mesh item
 *    pointing at a filing or official release gets the PRIMARY document
 *    fetched, parsed, and queued with its own attribution."
 *
 * So a Bluesky post is a SIGNAL that something may have happened, recorded at
 * log-only score and never enqueued. What the desk publishes is the filing the
 * post pointed at, carded by the lane that owns it, citing the source. Same
 * design as the PR wires (p5-21), and for the same reason: there is no
 * archetype here, no attribution entry and no template, because there is
 * nothing for them to render.
 *
 * Social is a strictly weaker signal than a vendor wire, so the ban is
 * stricter, not looser: a wire item at least comes from an issuer's own PR
 * desk, while a Bluesky post is anyone with an account.
 *
 * ENDPOINTS LIVE-VERIFIED 2026-08-08 (docs/verification/):
 *   api.bsky.app        app.bsky.feed.searchPosts   200, 25 posts   (unauth)
 *   public.api.bsky.app app.bsky.feed.searchPosts   403 HTML page   (CDN block)
 *   bsky.social         app.bsky.feed.searchPosts   401 AuthMissing (a PDS)
 *
 * The first reading of this lane concluded search "requires auth" because the
 * only host tried was `public.api.bsky.app`. It does not. See D-87.
 */

/**
 * THE APPVIEW HOST, and getting this wrong cost the lane its first live run
 * (D-87). Measured 2026-08-08 on `app.bsky.feed.searchPosts`, unauthenticated:
 *
 *   public.api.bsky.app   403  <- an HTML "403 Forbidden" PAGE, not an API error
 *   api.bsky.app          200  <- real results
 *   bsky.social           401  AuthMissing (correct: a PDS wants a session)
 *
 * The 403 from `public.api.bsky.app` is a CDN block on this endpoint, and it
 * looks exactly like an authorization requirement. It is not one: search
 * answers anonymously on `api.bsky.app` and returns 25 posts per query on
 * every watch term. The credential was never the constraint; the hostname was.
 */
const APPVIEW = "https://api.bsky.app";
const PDS = "https://bsky.social";

export const SOURCE = "bluesky_discovery";

/** Session tokens live ~2h, so this is one KV write per couple of hours —
 *  well inside the low-write budget KV is reserved for. */
const KV_SESSION = "bluesky:session";

/** Per-run insert cap. Search returns a lot and none of it can card. */
export const MAX_POSTS_PER_RUN = 25;

/**
 * What the lane watches for.
 *
 * DELIBERATELY NARROW and filing-shaped. The lane's only job is to notice that
 * a primary document may exist, so the terms name DOCUMENTS, not topics or
 * tickers. "SEC filing" is a useful pointer; "$TSLA" would drag in the entire
 * retail timeline and teach the lake nothing.
 */
export const WATCH_TERMS: readonly string[] = [
  "8-K filed",
  "Form 4 filed",
  "Schedule 13D",
  "SEC enforcement action",
  "WASDE report",
];

export function isEnabled(env: Env): boolean {
  return env.BLUESKY_ENABLED === "true";
}

interface Session {
  readonly accessJwt: string;
  readonly did: string;
}

/**
 * App-password session, cached in KV.
 *
 * The password is a SECRET and the handle is config; both are required and
 * neither has a default. A lane that silently ran with a missing credential
 * would look healthy and ingest nothing, which is the failure mode this repo
 * has already paid for twice (D-71, D-72).
 */
async function session(env: Env): Promise<Session> {
  const cached = await env.KV.get(KV_SESSION);
  if (cached) {
    try {
      return JSON.parse(cached) as Session;
    } catch {
      // A corrupt cache entry re-authenticates rather than wedging the lane.
    }
  }
  const identifier = env.BLUESKY_IDENTIFIER;
  const password = env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) {
    throw new Error("bluesky: BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD are both required");
  }
  const res = await politeFetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    userAgent: buildUserAgent(env.CONTACT_EMAIL),
    method: "POST",
    timeoutMs: 20_000,
    headers: { "content-type": "application/json" },
    postBody: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) throw new Error(`bluesky createSession ${res.status}`);
  const body = JSON.parse(res.body) as { accessJwt?: string; did?: string };
  if (!body.accessJwt || !body.did) throw new Error("bluesky createSession: no accessJwt");
  const s: Session = { accessJwt: body.accessJwt, did: body.did };
  // Refreshed well before the ~2h expiry so a poll never races the boundary.
  await env.KV.put(KV_SESSION, JSON.stringify(s), { expirationTtl: 5400 });
  return s;
}

export interface BskyPost {
  readonly uri: string;
  readonly cid: string;
  readonly handle: string;
  readonly text: string;
  readonly createdAt: string | null;
}

/** Parse a searchPosts response. Shape verified live 2026-08-07. */
export function parseSearchPosts(json: string): BskyPost[] {
  let body: { posts?: unknown };
  try {
    body = JSON.parse(json) as { posts?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(body.posts)) return [];
  const out: BskyPost[] = [];
  for (const raw of body.posts) {
    const p = raw as {
      uri?: string;
      cid?: string;
      author?: { handle?: string };
      record?: { text?: string; createdAt?: string };
    };
    const uri = typeof p.uri === "string" ? p.uri : "";
    const handle = typeof p.author?.handle === "string" ? p.author.handle : "";
    const text = typeof p.record?.text === "string" ? p.record.text : "";
    if (!uri || !handle || !text) continue;
    const created = typeof p.record?.createdAt === "string" ? Date.parse(p.record.createdAt) : NaN;
    out.push({
      uri,
      cid: typeof p.cid === "string" ? p.cid : "",
      handle,
      text,
      createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
    });
  }
  return out;
}

/** `at://did:plc:abc/app.bsky.feed.post/xyz` -> the public web permalink. */
export function permalink(uri: string, handle: string): string {
  const rkey = uri.split("/").pop() ?? "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

export async function pollBluesky(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<number> {
  if (!isEnabled(env)) return 0;
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);

  try {
    // SESSION IS BEST EFFORT (D-87). Search answers anonymously on the AppView,
    // so a credential problem must not take the lane down: the owner
    // provisioned an app password, we use it when it works, and we still poll
    // when it does not. Requiring it would trade a working lane for a
    // theoretical rate-limit benefit that has never been measured.
    let auth: Record<string, string> = {};
    try {
      const s = await session(env);
      auth = { authorization: `Bearer ${s.accessJwt}` };
    } catch (e) {
      log("warn", "bluesky session unavailable; polling anonymously", { source: SOURCE, error: String(e) });
    }
    let inserted = 0;
    for (const term of WATCH_TERMS) {
      if (!budget.take(1)) {
        log("warn", "tick budget exhausted mid-bluesky poll", { source: SOURCE, term });
        break;
      }
      const url = `${APPVIEW}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(term)}&limit=25`;
      const res = await politeFetch(url, {
        userAgent: buildUserAgent(env.CONTACT_EMAIL),
        timeoutMs: 20_000,
        headers: auth,
      });
      if (!res.ok) {
        // A 401 means the cached session died early; drop it so the next tick
        // re-authenticates rather than looping on a stale token.
        if (res.status === 401) await env.KV.delete(KV_SESSION);
        throw new Error(`bluesky searchPosts ${res.status} for "${term}"`);
      }
      const posts = parseSearchPosts(res.body);
      for (const p of posts.slice(0, MAX_POSTS_PER_RUN)) {
        const result = await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: p.uri,
            category: "social_discovery",
            eventAt: p.createdAt,
            sourceUrl: permalink(p.uri, p.handle),
            payload: { handle: p.handle, text: p.text, term, uri: p.uri, createdAt: p.createdAt },
            // LOG-ONLY, ALWAYS. There is no branch that raises this, and that
            // is the point: a social post is discovery and can never card.
            score: SCORE_LOG_ONLY,
            status: "logged",
          },
          now,
        );
        if (result.outcome === "inserted") inserted += 1;
      }
    }
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);
    if (inserted > 0) log("info", "bluesky discovery", { source: SOURCE, inserted });
    return inserted;
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    await recordSourceError(env.DB, SOURCE, e, now).catch(() => {});
    log("error", "bluesky poll failed", { source: SOURCE, error: String(e) });
    return 0;
  }
}

export function blueskyJob() {
  return (env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> =>
    pollBluesky(env, now, budget).then(() => undefined);
}
