import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { clampThreadsText, getThreadsAuth, storeThreadsAuth, THREADS_TEXT_LIMIT, ThreadsError } from "../src/lib/threads";
import { runPoster, refreshThreadsToken } from "../src/poster";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE, setQueueTelegramMessageId } from "../src/lib/db";
import { iso } from "../src/lib/time";

const TG = "https://graph.threads.net";
const NOW = new Date("2026-07-27T15:00:00Z");

// env with posting enabled (wrangler.toml ships POSTING_ENABLED="false").
const postingEnv = () => Object.assign(Object.create(Object.getPrototypeOf(env)), env, { POSTING_ENABLED: "true" });

const TGRAM = { calls: [] as Array<{ path: string; body: Record<string, unknown> }> };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  // Persistent counters (see webhook.test.ts for the shadowing rationale).
  for (const method of ["sendMessage", "editMessageText"]) {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: `/botTEST:TOKEN/${method}`, method: "POST" })
      .reply(200, (opts) => {
        TGRAM.calls.push({ path: method, body: JSON.parse(String(opts.body)) as Record<string, unknown> });
        return JSON.stringify({ ok: true, result: { message_id: 990 + TGRAM.calls.length } });
      })
      .persist();
  }
});

async function seedApproved(externalId: string, draft: string, edited?: string): Promise<{ itemId: number; queueId: number }> {
  const item = await insertItem(env.DB, {
    source: "edgar_8k",
    externalId,
    category: "filing",
    eventAt: iso(NOW),
    sourceUrl: `https://www.sec.gov/Archives/${externalId}`,
    payload: {},
    score: SCORE_POSTABLE,
  });
  const queueId = await createQueueEntry(env.DB, item.id ?? 0, "FILING_ALERT", draft, NOW);
  await setQueueTelegramMessageId(env.DB, queueId, 500 + queueId);
  await decideQueueEntry(env.DB, queueId, "approved", NOW);
  if (edited) {
    await env.DB.prepare("UPDATE queue SET state = 'edited', edited_text = ?1 WHERE id = ?2").bind(edited, queueId).run();
  }
  return { itemId: item.id ?? 0, queueId };
}

async function connectThreads(): Promise<void> {
  await storeThreadsAuth(env.KV, { token: "LONGTOKEN", userId: "77", expiresInSeconds: 60 * 86400, username: "skepticwire", now: NOW });
}

function mockQuota(used = 3): void {
  fetchMock
    .get(TG)
    .intercept({ path: /\/v1\.0\/77\/threads_publishing_limit.*/ })
    .reply(200, JSON.stringify({ data: [{ quota_usage: used, config: { quota_total: 250 } }] }));
}

describe("clampThreadsText", () => {
  it("caps at the verified 500-char limit, surrogate-safe", () => {
    expect(clampThreadsText("x".repeat(600)).length).toBe(THREADS_TEXT_LIMIT);
    expect(clampThreadsText("short")).toBe("short");
  });
});

describe("runPoster", () => {
  it("does nothing while POSTING_ENABLED is false (the shipped default)", async () => {
    await connectThreads();
    await seedApproved("P-off", "draft");
    await runPoster(env, NOW); // real env: POSTING_ENABLED="false"
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM post_log").first<{ n: number }>())?.n).toBe(0);
  });

  it("posts an approved draft with the source as link_attachment, logs it, badges Telegram", async () => {
    await connectThreads();
    const { itemId, queueId } = await seedApproved("P-1", "8-K: ACME CORP\nItem 4.02 — Non-Reliance");
    mockQuota();
    let sent: URLSearchParams | null = null;
    fetchMock
      .get(TG)
      .intercept({ path: "/v1.0/77/threads", method: "POST" })
      .reply(200, (opts) => {
        sent = new URLSearchParams(String(opts.body));
        return JSON.stringify({ id: "THREADS_POST_9" });
      });

    await runPoster(postingEnv(), NOW);

    expect(sent!.get("media_type")).toBe("TEXT");
    expect(sent!.get("auto_publish_text")).toBe("true");
    expect(sent!.get("text")).toContain("8-K: ACME CORP");
    expect(sent!.get("link_attachment")).toBe("https://www.sec.gov/Archives/P-1");
    expect(sent!.get("access_token")).toBe("LONGTOKEN");

    const logRow = await env.DB.prepare("SELECT * FROM post_log WHERE queue_id = ?1").bind(queueId).first<Record<string, unknown>>();
    expect(logRow).toMatchObject({ platform_post_id: "THREADS_POST_9", archetype: "FILING_ALERT", category: "filing" });
    expect(
      (await env.DB.prepare("SELECT status FROM items WHERE id = ?1").bind(itemId).first<{ status: string }>())?.status,
    ).toBe("posted");
    expect(TGRAM.calls.some((c) => c.path === "editMessageText" && String(c.body.text).includes("📤 Posted"))).toBe(true);

    // Second run: already in post_log -> nothing re-posts (returns before the
    // quota fetch, so no interceptor is needed — or leaked).
    await runPoster(postingEnv(), NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM post_log").first<{ n: number }>())?.n).toBe(1);
  });

  it("what posts is exactly what was approved: edited_text wins, draft never leaks", async () => {
    await connectThreads();
    await seedApproved("P-2", "ORIGINAL DRAFT", "the corrected text");
    mockQuota();
    let sent: URLSearchParams | null = null;
    fetchMock
      .get(TG)
      .intercept({ path: "/v1.0/77/threads", method: "POST" })
      .reply(200, (opts) => {
        sent = new URLSearchParams(String(opts.body));
        return JSON.stringify({ id: "T2" });
      });
    await runPoster(postingEnv(), NOW);
    expect(sent!.get("text")).toBe("the corrected text");
    expect(sent!.get("text")).not.toContain("ORIGINAL DRAFT");
  });

  it("editorial daily cap holds posts back", async () => {
    await connectThreads();
    // Fill post_log to the cap with synthetic rows inside the 24h window.
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare("INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category) VALUES (NULL, ?1, ?2, 'WIRE', 'x')")
        .bind(`old-${i}`, iso(new Date(NOW.getTime() - 3_600_000)))
        .run();
    }
    await seedApproved("P-3", "held back");
    await runPoster(postingEnv(), NOW); // no quota/publish mocks: any fetch would throw -> logged as failure
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM post_log WHERE queue_id IS NOT NULL").first<{ n: number }>())?.n).toBe(0);
  });

  it("platform quota near exhaustion holds posts", async () => {
    await connectThreads();
    await seedApproved("P-4", "quota hold");
    mockQuota(249);
    await runPoster(postingEnv(), NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM post_log").first<{ n: number }>())?.n).toBe(0);
  });

  it("token-invalid (HTTP 500 + code 190, the verified quirk) pauses and alerts ONCE", async () => {
    await connectThreads();
    await seedApproved("P-5", "will not post");
    const t0 = TGRAM.calls.filter((c) => c.path === "sendMessage").length;
    fetchMock
      .get(TG)
      .intercept({ path: /\/v1\.0\/77\/threads_publishing_limit.*/ })
      .reply(500, JSON.stringify({ error: { message: "Invalid OAuth 2.0 Access Token", type: "THApiException", code: 190 } }))
      .times(2);

    await runPoster(postingEnv(), NOW);
    await runPoster(postingEnv(), NOW); // alert already sent -> no second message

    const alerts = TGRAM.calls.filter((c) => c.path === "sendMessage" && String(c.body.text).includes("Threads token"));
    expect(alerts.length - (t0 > 0 ? 0 : 0)).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM post_log").first<{ n: number }>())?.n).toBe(0);
  });
  it("a crash between publish and confirmation NEVER double-posts (pre-claim)", async () => {
    await connectThreads();
    await seedApproved("P-crash", "one approval, one post");
    mockQuota();
    let publishes = 0;
    fetchMock
      .get(TG)
      .intercept({ path: "/v1.0/77/threads", method: "POST" })
      .reply(200, () => {
        publishes += 1;
        return JSON.stringify({ id: `T-crash-${publishes}` });
      })
      .persist();

    // Simulate the isolate dying right after the publish resolves: the
    // confirmation batch throws, so no post id is ever recorded.
    const crashing = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
      POSTING_ENABLED: "true",
      DB: Object.assign(Object.create(Object.getPrototypeOf(env.DB)), env.DB, {
        prepare: env.DB.prepare.bind(env.DB),
        batch: () => Promise.reject(new Error("isolate evicted")),
      }),
    });
    await runPoster(crashing, NOW);
    expect(publishes).toBe(1);

    // Next run must NOT re-publish: the claim row survives the crash.
    await runPoster(postingEnv(), NOW);
    expect(publishes).toBe(1);
  });

  it("rejected and expired rows are never posted", async () => {
    await connectThreads();
    const { queueId: rej } = await seedApproved("P-rej", "rejected draft");
    await env.DB.prepare("UPDATE queue SET state = 'rejected' WHERE id = ?1").bind(rej).run();
    const { queueId: exp } = await seedApproved("P-exp", "expired draft");
    await env.DB.prepare("UPDATE queue SET state = 'expired' WHERE id = ?1").bind(exp).run();

    // No publish interceptor: a publish attempt would throw and be visible
    // as a failed post; assert nothing was even claimed.
    await runPoster(postingEnv(), NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM post_log").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("refreshThreadsToken", () => {
  it("a successful refresh clears the token-alert suppressor so new failures alert", async () => {
    await env.KV.put("threads:token_alert_sent", "1");
    await storeThreadsAuth(env.KV, { token: "T", userId: "77", expiresInSeconds: 60 * 86400, now: NOW });
    expect(await env.KV.get("threads:token_alert_sent")).toBeNull();
  });

  it("refreshes when the last refresh is >7 days old and persists the new token", async () => {
    await storeThreadsAuth(env.KV, {
      token: "OLDTOKEN",
      userId: "77",
      expiresInSeconds: 40 * 86400,
      now: new Date(NOW.getTime() - 8 * 86_400_000),
    });
    fetchMock
      .get(TG)
      .intercept({ path: /\/refresh_access_token.*/ })
      .reply(200, JSON.stringify({ access_token: "NEWTOKEN", token_type: "bearer", expires_in: 5_184_000 }));

    await refreshThreadsToken(env, NOW);
    const auth = await getThreadsAuth(env.KV);
    expect(auth?.token).toBe("NEWTOKEN");
    expect(auth?.refreshedAt).toBe(iso(NOW));
  });

  it("skips when refreshed recently", async () => {
    await storeThreadsAuth(env.KV, { token: "FRESH", userId: "77", expiresInSeconds: 60 * 86400, now: NOW });
    await refreshThreadsToken(env, new Date(NOW.getTime() + 86_400_000)); // 1 day later: no interceptor -> a fetch would fail
    expect((await getThreadsAuth(env.KV))?.token).toBe("FRESH");
  });
});

describe("oauth routes", () => {
  it("start: rejects a bad key; with the right key redirects to Threads with a stored state", async () => {
    expect((await SELF.fetch("https://worker.local/threads/oauth/start?key=nope", { redirect: "manual" })).status).toBe(401);

    const res = await SELF.fetch("https://worker.local/threads/oauth/start?key=test-webhook-secret", { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://threads.net/oauth/authorize");
    expect(loc.searchParams.get("scope")).toBe("threads_basic,threads_content_publish");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://worker.local/threads/oauth/callback");
    const state = loc.searchParams.get("state")!;
    expect(await env.KV.get("threads:oauth_state")).toBe(state);
  });

  it("callback: exchanges code -> short -> long-lived, stores auth, and burns the state", async () => {
    await env.KV.put("threads:oauth_state", "STATE1", { expirationTtl: 600 });
    fetchMock
      .get(TG)
      .intercept({ path: "/oauth/access_token", method: "POST" })
      .reply(200, JSON.stringify({ access_token: "SHORT", user_id: 7788 }));
    fetchMock
      .get(TG)
      .intercept({ path: /\/access_token\?(?=.*th_exchange_token)/ })
      .reply(200, JSON.stringify({ access_token: "LONG", token_type: "bearer", expires_in: 5_184_000 }));
    fetchMock
      .get(TG)
      .intercept({ path: /\/v1\.0\/me.*/ })
      .reply(200, JSON.stringify({ id: "7788", username: "skepticwire" }));

    const res = await SELF.fetch("https://worker.local/threads/oauth/callback?code=CODE9&state=STATE1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("@skepticwire");

    const auth = await getThreadsAuth(env.KV);
    expect(auth).toMatchObject({ token: "LONG", userId: "7788" });
    expect(await env.KV.get("threads:oauth_state")).toBeNull(); // single use

    // Replay with the burned state fails.
    expect((await SELF.fetch("https://worker.local/threads/oauth/callback?code=CODE9&state=STATE1")).status).toBe(403);
  });
});

describe("threads error contract", () => {
  it("HTTP 500 + code 190 classifies as token-invalid", () => {
    const e = new ThreadsError(190, "Invalid OAuth 2.0 Access Token", 500);
    expect(e.isTokenInvalid).toBe(true);
    expect(new ThreadsError(4, "rate", 400).isTokenInvalid).toBe(false);
  });
});
