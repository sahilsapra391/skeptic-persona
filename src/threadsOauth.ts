import type { Env } from "./env";
import { safeEqual } from "./telegram/webhook";
import { exchangeCode, exchangeLongLived, getMe, storeThreadsAuth, THREADS_AUTH_URL } from "./lib/threads";
import { log } from "./lib/log";

// One-time (plus recovery) OAuth flow, hosted BY the Worker so onboarding is
// just opening a URL: /threads/oauth/start redirects to Threads' consent
// screen; the registered redirect URI points back at /threads/oauth/callback,
// which exchanges code -> short-lived -> long-lived token and stores it in
// KV. The start route is gated by the owner's webhook secret; the callback
// is gated by the single-use state nonce minted at start.

export const OAUTH_START_PATH = "/threads/oauth/start";
export const OAUTH_CALLBACK_PATH = "/threads/oauth/callback";
const KV_STATE = "threads:oauth_state";

function redirectUri(requestUrl: URL): string {
  return `${requestUrl.origin}${OAUTH_CALLBACK_PATH}`;
}

export async function handleOauthStart(request: Request, env: Env): Promise<Response> {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) return new Response("threads app not configured", { status: 503 });
  if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response("not configured", { status: 503 });
  const key = new URL(request.url).searchParams.get("key");
  if (!key || !safeEqual(key, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });

  // Single-use CSRF nonce, 10-minute window.
  const state = crypto.randomUUID();
  await env.KV.put(KV_STATE, state, { expirationTtl: 600 });

  const url = new URL(THREADS_AUTH_URL);
  url.searchParams.set("client_id", env.THREADS_APP_ID);
  url.searchParams.set("redirect_uri", redirectUri(new URL(request.url)));
  url.searchParams.set("scope", "threads_basic,threads_content_publish");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

export async function handleOauthCallback(request: Request, env: Env): Promise<Response> {
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) return new Response("threads app not configured", { status: 503 });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = await env.KV.get(KV_STATE);
  if (!code || !state || !expected || !safeEqual(state, expected)) {
    return new Response("invalid oauth state", { status: 403 });
  }
  await env.KV.delete(KV_STATE); // single use

  try {
    // Verified quirk: Threads appends '#_' to the redirect — a fragment, so
    // it never reaches the server; the code param arrives clean.
    const short = await exchangeCode(env.THREADS_APP_ID, env.THREADS_APP_SECRET, redirectUri(url), code);
    const long = await exchangeLongLived(env.THREADS_APP_SECRET, short.access_token);
    const me = await getMe(long.access_token);
    await storeThreadsAuth(env.KV, {
      token: long.access_token,
      userId: me.id || short.user_id,
      expiresInSeconds: long.expires_in,
      username: me.username,
    });
    log("info", "threads connected", { userId: me.id, username: me.username ?? null });
    return new Response(
      `<html><body style="font-family: system-ui; padding: 2rem">
        <h2>Skeptic Wire connected to Threads ✅</h2>
        <p>Account: <b>@${me.username ?? short.user_id}</b></p>
        <p>Long-lived token stored; the weekly refresh job keeps it alive.
        You can close this tab. Posting stays off until POSTING_ENABLED=true.</p>
      </body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  } catch (e) {
    log("error", "threads oauth exchange failed", { error: String(e) });
    return new Response(`oauth exchange failed: ${String(e)}`, { status: 502 });
  }
}
