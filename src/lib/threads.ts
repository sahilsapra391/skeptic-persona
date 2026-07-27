// Threads Graph API client (live-verified 2026-07-26, docs/verification/):
// hosts graph.threads.net / graph.threads.com, path version v1.0.
// Verified quirks this file encodes:
// - Invalid/expired tokens return HTTP 500 with JSON error.code 190 — never
//   trust the status class alone (unlike Telegram, whose statuses are clean).
// - TEXT posts collapse to ONE call with auto_publish_text=true.
// - link_attachment carries the source URL OUTSIDE the 500-char text budget
//   (TEXT posts only) and forces the preview card.
// - Long-lived tokens die at 60 days; refresh needs the token >=24h old and
//   restarts the clock; an EXPIRED token is unrecoverable (manual OAuth).
// - Publishing quota: 250 posts / rolling 24h, queryable via
//   GET /{user-id}/threads_publishing_limit.

export const THREADS_GRAPH = "https://graph.threads.net/v1.0";
export const THREADS_AUTH_URL = "https://threads.net/oauth/authorize";
export const THREADS_TEXT_LIMIT = 500;

export class ThreadsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number,
  ) {
    super(`threads ${code}: ${message}`);
  }
  /** Verified: token problems surface as code 190 (often under HTTP 500). */
  get isTokenInvalid(): boolean {
    return this.code === 190;
  }
}

async function thFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const raw = await res.text();
  let body: { error?: { message?: string; code?: number } } & T;
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new ThreadsError(res.status, `non-JSON response: ${raw.slice(0, 120)}`, res.status);
  }
  if (body.error || !res.ok) {
    throw new ThreadsError(body.error?.code ?? res.status, body.error?.message ?? "unknown", res.status);
  }
  return body;
}

/** Clamp to the 500-char limit, never splitting a surrogate pair. */
export function clampThreadsText(text: string): string {
  if (text.length <= THREADS_TEXT_LIMIT) return text;
  let cut = THREADS_TEXT_LIMIT - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

/**
 * Publish a TEXT post in one call (auto_publish_text). The source link rides
 * in link_attachment — outside the text budget, per the no-fabrication rule
 * that every post carries its source.
 */
export async function publishTextPost(
  token: string,
  userId: string,
  text: string,
  linkAttachment?: string,
): Promise<{ id: string }> {
  const params = new URLSearchParams({
    media_type: "TEXT",
    text: clampThreadsText(text),
    auto_publish_text: "true",
    access_token: token,
  });
  if (linkAttachment) params.set("link_attachment", linkAttachment);
  return thFetch<{ id: string }>(`${THREADS_GRAPH}/${userId}/threads`, { method: "POST", body: params });
}

export interface PublishingQuota {
  used: number;
  total: number;
}

export async function getPublishingQuota(token: string, userId: string): Promise<PublishingQuota | null> {
  const body = await thFetch<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
    `${THREADS_GRAPH}/${userId}/threads_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(token)}`,
  );
  const row = body.data?.[0];
  if (!row || row.quota_usage === undefined) return null;
  return { used: row.quota_usage, total: row.config?.quota_total ?? 250 };
}

/** Auth-code -> short-lived token (verified: POST form to /oauth/access_token). */
export async function exchangeCode(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
): Promise<{ access_token: string; user_id: string }> {
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const res = await thFetch<{ access_token: string; user_id: number | string }>(
    `${THREADS_GRAPH.replace("/v1.0", "")}/oauth/access_token`,
    { method: "POST", body },
  );
  return { access_token: res.access_token, user_id: String(res.user_id) };
}

/** Short-lived (1h) -> long-lived (60d). Server-side only: carries the app secret. */
export async function exchangeLongLived(appSecret: string, shortToken: string): Promise<{ access_token: string; expires_in: number }> {
  return thFetch<{ access_token: string; expires_in: number }>(
    `${THREADS_GRAPH.replace("/v1.0", "")}/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortToken)}`,
  );
}

/** Refresh a long-lived token (must be >=24h old and unexpired). */
export async function refreshLongLived(token: string): Promise<{ access_token: string; expires_in: number }> {
  return thFetch<{ access_token: string; expires_in: number }>(
    `${THREADS_GRAPH.replace("/v1.0", "")}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
  );
}

/** Recent posts on the account. Used to reconcile stranded publish claims. */
export async function listRecentPosts(
  token: string,
  userId: string,
  limit = 25,
): Promise<Array<{ id: string; text?: string }>> {
  const body = await thFetch<{ data?: Array<{ id: string; text?: string }> }>(
    `${THREADS_GRAPH}/${userId}/threads?fields=id,text&limit=${limit}&access_token=${encodeURIComponent(token)}`,
  );
  return body.data ?? [];
}

export async function getMe(token: string): Promise<{ id: string; username?: string }> {
  return thFetch<{ id: string; username?: string }>(
    `${THREADS_GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(token)}`,
  );
}

// ---------------------------------------------------------------------------
// Token storage: KV is the right home (verified KV free tier: 1k writes/day;
// this writes once per OAuth + once per weekly refresh). The Worker cannot
// update its own secrets, so the LIVE token always comes from KV.

const KV_TOKEN = "threads:token";
const KV_EXPIRES = "threads:token_expires_at";
const KV_REFRESHED = "threads:token_refreshed_at";
const KV_USER = "threads:user_id";
const KV_USERNAME = "threads:username";

export interface ThreadsAuth {
  token: string;
  userId: string;
  expiresAt: string | null;
  refreshedAt: string | null;
}

export async function getThreadsAuth(kv: KVNamespace): Promise<ThreadsAuth | null> {
  const [token, userId, expiresAt, refreshedAt] = await Promise.all([
    kv.get(KV_TOKEN),
    kv.get(KV_USER),
    kv.get(KV_EXPIRES),
    kv.get(KV_REFRESHED),
  ]);
  if (!token || !userId) return null;
  return { token, userId, expiresAt, refreshedAt };
}

export const KV_TOKEN_ALERTED = "threads:token_alert_sent";

export async function storeThreadsAuth(
  kv: KVNamespace,
  args: { token: string; userId: string; expiresInSeconds: number; username?: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const expires = new Date(now.getTime() + args.expiresInSeconds * 1000);
  await Promise.all([
    // Healthy auth clears the alert suppressor, so a NEW failure always
    // alerts instead of being swallowed by a stale 6h flag.
    kv.delete(KV_TOKEN_ALERTED),
    kv.put(KV_TOKEN, args.token),
    kv.put(KV_USER, args.userId),
    kv.put(KV_EXPIRES, expires.toISOString()),
    kv.put(KV_REFRESHED, now.toISOString()),
    ...(args.username ? [kv.put(KV_USERNAME, args.username)] : []),
  ]);
}
