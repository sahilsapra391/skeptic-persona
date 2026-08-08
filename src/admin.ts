import type { Env } from "./env";
import { insertItem, SCORE_POSTABLE } from "./lib/db";
import { enqueueForApproval } from "./pipeline/enqueue";
import { safeEqual } from "./telegram/webhook";
import { buildUserAgent, politeFetch } from "./lib/http";
import { iso } from "./lib/time";

/**
 * Owner smoke test: POST /admin/seed-test with header
 * `X-Admin-Key: <TELEGRAM_WEBHOOK_SECRET>` injects a fake draft into the
 * approval queue so the full Telegram loop (message, buttons, decisions,
 * expiry) can be exercised end-to-end before any real ingester exists.
 * Items land under source "smoke_test" and never touch a poster.
 */
export async function handleSeedTest(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return new Response("not configured", { status: 503 });
  }
  const key = request.headers.get("X-Admin-Key");
  if (!key || !safeEqual(key, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const now = new Date();
  const item = await insertItem(
    env.DB,
    {
      source: "smoke_test",
      externalId: iso(now),
      category: "filing",
      eventAt: iso(now),
      sourceUrl: "https://www.example.gov/smoke-test",
      payload: { note: "owner smoke test; safe to approve or reject" },
      score: SCORE_POSTABLE,
    },
    now,
  );
  if (item.outcome === "duplicate" || item.id === null) {
    return Response.json({ error: "duplicate (same-millisecond retry?)" }, { status: 409 });
  }
  // Uses the real engine so the smoke test exercises the render path too.
  const { queueId } = await enqueueForApproval(
    env,
    item.id,
    "HALT",
    {
      // Self-identifying: this must never read as a real halt if it somehow
      // reached the account. The poster also excludes source='smoke_test'.
      symbol: "SMOKE TEST",
      name: "Skeptic Wire self-test, not a real halt",
      reasonText: "News Pending",
      reasonCode: "T1",
      haltTimeEtShort: "09:30",
    },
    "https://www.example.gov/smoke-test",
    now,
    undefined,
    // The smoke test exists to prove the pipeline end to end, so it must
    // reach Telegram whatever the salience settings are. Without this it is
    // curated by the very layer it is meant to verify: a T1 halt scores 70,
    // which clears the floor but not a tightened one, so the endpoint would
    // start returning queueId 0 and look broken.
    { bypassSalience: true },
  );
  return Response.json({ ok: true, queueId });
}

/** Cap on drafts returned by the history endpoint. Roughly ten cycles at
 *  MAX_ATTEMPTS x 3 variants, which is far past what a real row accumulates. */
const HISTORY_ROW_LIMIT = 120;

/**
 * Draft history for one queue row: GET /admin/generations?queue_id=N with
 * header `X-Admin-Key: <TELEGRAM_WEBHOOK_SECRET>`.
 *
 * This is the "history retrievable" half of p5-01. Append-only storage is
 * only half a fix: drafts that survive a Regenerate but that nothing can read
 * back are indistinguishable from drafts that were deleted, and this pipeline
 * has already been burned by state whose existence nobody could confirm.
 *
 * Read-only by construction. There is deliberately no restore endpoint: the
 * owner's route back to an earlier draft is Edit, which is already recorded
 * as a decision, whereas a silent server-side revert would leave the card and
 * the audit trail disagreeing about what was chosen.
 */
export async function handleGenerationHistory(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response("not configured", { status: 503 });
  const key = request.headers.get("X-Admin-Key");
  if (!key || !safeEqual(key, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const queueId = Number(new URL(request.url).searchParams.get("queue_id"));
  if (!Number.isInteger(queueId) || queueId <= 0) {
    return Response.json({ error: "queue_id must be a positive integer" }, { status: 400 });
  }
  const q = await env.DB.prepare(`SELECT regen_cycle FROM queue WHERE id = ?1`)
    .bind(queueId)
    .first<{ regen_cycle: number }>();
  if (!q) return Response.json({ error: `no queue row ${queueId}` }, { status: 404 });

  // BOUNDED. A heavily regenerated row is exactly this endpoint's use case,
  // and each cycle can add ~12 rows (MAX_ATTEMPTS x 3 variants), so an
  // unbounded select would grow without limit precisely where it is most
  // likely to be called. Newest cycles first inside the limit, then sorted
  // back into ascending order for the response.
  const rows = await env.DB.prepare(
    `SELECT id, cycle, variant, status, attempt, created_at, text FROM (
       SELECT id, cycle, variant, status, attempt, created_at, text
       FROM generations WHERE queue_id = ?1
       ORDER BY cycle DESC, attempt DESC, id DESC LIMIT ${HISTORY_ROW_LIMIT}
     ) ORDER BY cycle ASC, attempt ASC, id ASC`,
  )
    .bind(queueId)
    .all<{
      id: number;
      cycle: number;
      variant: string;
      status: string;
      attempt: number;
      created_at: string;
      text: string;
    }>();

  // Grouped by cycle, because "what did the pass I threw away actually say"
  // is the question this endpoint exists to answer.
  const cycles = new Map<number, typeof rows.results>();
  for (const r of rows.results) {
    const bucket = cycles.get(r.cycle);
    if (bucket) bucket.push(r);
    else cycles.set(r.cycle, [r]);
  }
  return Response.json({
    queue_id: queueId,
    current_cycle: q.regen_cycle,
    returned_rows: rows.results.length,
    // Named rather than implied: a capped count silently reported as the total
    // is the reporter-says-success shape this repo keeps getting bitten by.
    // Oldest cycles are the ones dropped.
    truncated: rows.results.length === HISTORY_ROW_LIMIT,
    cycles: [...cycles.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([cycle, drafts]) => ({ cycle, current: cycle === q.regen_cycle, drafts })),
  });
}


/**
 * B-01.2 — hosts `/admin/probe` may be pointed at.
 *
 * The endpoint answers one question: does WORKER EGRESS reach this host? An
 * unrestricted version answers it for any host on the internet, which makes it
 * a generic egress proxy wearing a diagnostic's clothes. So the target list is
 * closed to hosts ALREADY IN THE SOURCE REGISTRY — things this desk either
 * fetches today or has formally recorded as a candidate.
 *
 * Adding a host here is therefore a two-step act: put it in the registry with
 * a status and a date first, then add it. That ordering is the point.
 *
 * Matching is exact hostname or a dot-suffix, so `sec.gov` covers
 * `www.sec.gov` and `data.sec.gov` but never `notsec.gov`.
 */
const PROBE_ALLOWED_HOSTS: readonly string[] = [
  // US federal
  "sec.gov", "fda.gov", "bls.gov", "federalregister.gov", "federalreserve.gov",
  "cftc.gov", "ftc.gov", "justice.gov", "gao.gov", "eia.gov", "bea.gov",
  "consumerfinance.gov", "treasury.gov", "treasurydirect.gov", "fiscaldata.treasury.gov",
  "nhc.noaa.gov", "house.gov", "senate.gov",
  // Exchanges
  "nasdaqtrader.com", "nyse.com",
  // Central banks and overseas regulators
  "bankofcanada.ca", "bankofengland.co.uk", "bcb.gov.br", "boi.org.il", "boj.or.jp",
  "ecb.europa.eu", "europa.eu", "eba.europa.eu", "fca.org.uk", "finma.ch", "gov.uk",
  "norges-bank.no", "ons.gov.uk", "rba.gov.au", "rbi.org.in", "resbank.co.za",
  "riksbank.se", "sebi.gov.in", "snb.ch", "wto.org",
  // PR wires: registry candidates as of 2026-08-06 (p5-21), recorded there
  // with their residential probe results before being added here.
  "globenewswire.com", "prnewswire.com", "accesswire.com",
];

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return PROBE_ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

/**
 * POST /admin/probe — does WORKER EGRESS reach this host?
 *
 * WHY THIS EXISTS. D-25 is the standing lesson of this repo, and it has now
 * recurred three times: a probe from a laptop proves nothing about Cloudflare
 * Worker egress, and every time someone forgets that, a "fix" ships that was
 * never tested where it runs. rate_boe was declared fixed on a laptop curl and
 * was not. senate_ptr's cause was unknowable for three days. The PR-wire lane
 * needed the same answer before a single ingester was written.
 *
 * Answering it used to require writing an ingester and deploying it. Now it is
 * one call. That is the whole point: make the disciplined thing the cheap one.
 *
 * READ-ONLY BY CONSTRUCTION. GET only, no request body forwarded, no response
 * body returned — status, size, content-type and timing, which is everything a
 * reachability question needs and nothing that could relay content through the
 * Worker. Dedicated token (B-01.2) and a closed host allowlist, so it can be
 * neither an editorial forgery vector nor a generic egress proxy.
 */
export async function handleProbe(request: Request, env: Env): Promise<Response> {
  // B-01.2: a DEDICATED token, never TELEGRAM_WEBHOOK_SECRET. That secret's
  // blast radius is the editorial chain — anyone holding it can forge Approve
  // and Posted taps — so it is never shared with a session and never reused
  // for admin auth. A probe token can only ever cause a probe.
  if (!env.ADMIN_PROBE_TOKEN) return new Response("not configured", { status: 503 });
  const key = request.headers.get("X-Admin-Key");
  if (!key || !safeEqual(key, env.ADMIN_PROBE_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  let urls: unknown;
  try {
    urls = ((await request.json()) as { urls?: unknown }).urls;
  } catch {
    return Response.json({ error: "body must be JSON {urls:[...]}" }, { status: 400 });
  }
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 10) {
    return Response.json({ error: "urls must be a 1-10 item array" }, { status: 400 });
  }

  const userAgent = buildUserAgent(env.CONTACT_EMAIL);
  const results = [];
  for (const raw of urls) {
    if (typeof raw !== "string") {
      results.push({ url: String(raw), error: "not a string" });
      continue;
    }
    // https only. A probe endpoint that will fetch any scheme is a proxy.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      results.push({ url: raw, error: "unparseable" });
      continue;
    }
    if (parsed.protocol !== "https:") {
      results.push({ url: raw, error: "https only" });
      continue;
    }
    if (!hostAllowed(parsed.hostname)) {
      results.push({ url: raw, error: `host not in the source registry allowlist: ${parsed.hostname}` });
      continue;
    }
    const startedAt = Date.now();
    try {
      const res = await politeFetch(raw, { userAgent, timeoutMs: 20_000 });
      results.push({
        url: raw,
        status: res.status,
        ok: res.ok,
        bytes: res.body.length,
        contentType: res.contentType,
        ms: Date.now() - startedAt,
      });
    } catch (e) {
      results.push({ url: raw, error: String(e).slice(0, 200), ms: Date.now() - startedAt });
    }
  }
  return Response.json({ egress: "cloudflare-worker", probedAt: iso(new Date()), userAgent, results });
}

/**
 * B-14.1 / D-56 made permanent: does each credential actually WORK against the
 * deployed target?
 *
 * D-56 is the reason this exists. `wrangler secret put` reported success while
 * the Worker-side write had silently failed, and the only thing that caught it
 * was a live call that could tell auth-passed from auth-failed. "The secret is
 * set" and "the secret works" are different claims, and only one of them is
 * checkable from outside.
 *
 * WHAT THIS RETURNS, AND WHAT IT NEVER RETURNS. Per credential: whether the
 * binding is present, the HTTP status of one live authenticated call, and a
 * boolean for whether that call was accepted. It never returns the secret, any
 * part of it, or the response body — the same rule `handleProbe` follows, for
 * the same reason: a diagnostic that relays content is an exfiltration tool
 * wearing a diagnostic's clothes.
 *
 * ONE CALL PER CREDENTIAL, to a fixed endpoint chosen because it distinguishes
 * a bad key from a reachable service. A 200 or a 400 both mean auth passed; a
 * 401 or 403 means it did not.
 */
export interface CredResult {
  readonly name: string;
  readonly present: boolean;
  readonly status: number | null;
  readonly authAccepted: boolean | null;
  readonly note: string;
}

async function checkBluesky(env: Env): Promise<CredResult> {
  const name = "BLUESKY_APP_PASSWORD";
  const id = env.BLUESKY_IDENTIFIER;
  const pw = env.BLUESKY_APP_PASSWORD;
  if (!pw) return { name, present: false, status: null, authAccepted: null, note: "not bound to the Worker" };
  if (!id) return { name, present: true, status: null, authAccepted: null, note: "BLUESKY_IDENTIFIER is unset, so the password cannot be tested" };
  try {
    const res = await politeFetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      method: "POST",
      timeoutMs: 20_000,
      headers: { "content-type": "application/json" },
      postBody: JSON.stringify({ identifier: id, password: pw }),
    });
    if (!res.ok) {
      return { name, present: true, status: res.status, authAccepted: false, note: "createSession refused the credential" };
    }
    // B-14.2's actual question is not "does the password work" but "does
    // AUTHENTICATED searchPosts return results". A working session that then
    // gets a 403 on the only endpoint the lane needs is a working credential
    // and a dead lane, which is exactly what the first reading of p5-25
    // concluded. So the check goes one call further.
    const jwt = (JSON.parse(res.body) as { accessJwt?: string }).accessJwt;
    if (!jwt) return { name, present: true, status: res.status, authAccepted: true, note: "session created but carried no token" };
    const q = await politeFetch(
      "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=" + encodeURIComponent("8-K filed") + "&limit=5",
      { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000, headers: { authorization: `Bearer ${jwt}` } },
    );
    const n = q.ok ? ((JSON.parse(q.body) as { posts?: unknown[] }).posts ?? []).length : 0;
    return {
      name,
      present: true,
      status: q.status,
      authAccepted: q.ok && n > 0,
      note: q.ok
        ? `session OK; AUTHENTICATED searchPosts returned ${n} posts`
        : `session OK but authenticated searchPosts returned ${q.status}`,
    };
  } catch (e) {
    return { name, present: true, status: null, authAccepted: null, note: `call failed: ${String(e).slice(0, 80)}` };
  }
}

async function checkNass(env: Env): Promise<CredResult> {
  const name = "NASS_API_KEY";
  const key = env.NASS_API_KEY;
  if (!key) return { name, present: false, status: null, authAccepted: null, note: "not bound to the Worker" };
  try {
    // get_counts is the cheapest authenticated call NASS offers: it returns a
    // count, not a dataset, so a working key costs one small response.
    const url = `https://quickstats.nass.usda.gov/api/get_counts/?key=${encodeURIComponent(key)}&commodity_desc=CORN&year=2026`;
    const res = await politeFetch(url, { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000 });
    // 401 is the documented bad-key answer. A 400 means the key passed and the
    // QUERY was rejected, which still proves the credential.
    const accepted = res.status !== 401 && res.status !== 403;
    return {
      name,
      present: true,
      status: res.status,
      authAccepted: accepted,
      note: accepted ? "key accepted" : "key refused",
    };
  } catch (e) {
    return { name, present: true, status: null, authAccepted: null, note: `call failed: ${String(e).slice(0, 80)}` };
  }
}

/**
 * What the Actions-minutes digest line will actually read.
 *
 * NOT the billing endpoint. `/users/{u}/settings/billing/actions` is GONE —
 * it answered **410** to a valid token on 2026-08-08 (and 404 to a token
 * without the `user` scope, which is a different failure wearing similar
 * clothes). GitHub retired the per-user Actions billing route.
 *
 * The runs endpoint is live, needs only repo scope, and is a BETTER source for
 * the thing the digest is for: forecasting exhaustion. Minutes are derived
 * from real run durations rather than read from a number that lags. The
 * baseline this repo already measured (1.57 min/run over 20 runs, D-83) came
 * from exactly this data.
 */
export const GH_RUNS_URL =
  "https://api.github.com/repos/sahilsapra391/skeptic-persona/actions/runs?per_page=1";

async function checkGithub(env: Env): Promise<CredResult> {
  const name = "GH_BILLING_TOKEN";
  const t = env.GH_BILLING_TOKEN;
  if (!t) return { name, present: false, status: null, authAccepted: null, note: "not bound to the Worker" };
  try {
    // EXERCISES THE CAPABILITY, not just authentication (B-16.2). A token that
    // authenticates but lacks the `user` scope returns 403 here while being a
    // perfectly valid token — that is the p5-25 shape, where a working
    // credential and a dead capability looked identical from the outside.
    const res = await politeFetch(GH_RUNS_URL, {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
      headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return {
        name,
        present: true,
        status: res.status,
        authAccepted: false,
        note:
          res.status === 401 || res.status === 403
            ? "token rejected by the runs endpoint"
            : `runs endpoint returned ${res.status}`,
      };
    }
    const b = JSON.parse(res.body) as { total_count?: number };
    // The COUNT is the capability: if runs are readable, durations are
    // readable, and the digest line can be rendered. A count is not secret.
    return {
      name,
      present: true,
      status: res.status,
      authAccepted: typeof b.total_count === "number",
      note: `runs readable: ${b.total_count ?? "?"} total (minutes derive from run durations)`,
    };
  } catch (e) {
    return { name, present: true, status: null, authAccepted: null, note: `call failed: ${String(e).slice(0, 80)}` };
  }
}

export async function handleCredCheck(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PROBE_TOKEN) return new Response("not configured", { status: 503 });
  const key = request.headers.get("X-Admin-Key");
  if (!key || !safeEqual(key, env.ADMIN_PROBE_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  const results: CredResult[] = [await checkBluesky(env), await checkNass(env), await checkGithub(env)];
  return Response.json({ checkedAt: new Date().toISOString(), results });
}
