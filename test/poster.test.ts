import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clampThreadsText, getThreadsAuth, storeThreadsAuth, THREADS_TEXT_LIMIT, ThreadsError } from "../src/lib/threads";
import { runPoster, refreshThreadsToken, THREADS_PARKED } from "../src/poster";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE, setQueueTelegramMessageId } from "../src/lib/db";
import { iso } from "../src/lib/time";

// PARKED PLATFORM (2026-07-28). Meta banned @skeptictradess; the publish path
// is off behind THREADS_PARKED and both job rows are disabled in migration
// 0026. See docs/verification/2026-07-28-threads-ban.md.
//
// This file changed shape accordingly. It no longer asserts that publishing
// WORKS; it asserts that publishing CANNOT HAPPEN, which is the property that
// matters while parked, plus that the parked client's pure helpers still
// behave (the module stays on disk for the appeal).
//
// DOCTRINE DEBT, tracked deliberately: the publish-time register guard (the
// "LAST GATE BEFORE THE WORLD" check that rejected a hand-edited draft failing
// checkRegister) now sits inside unreachable code. checkRegister itself stays
// fully covered in templates.test.ts, but the INTEGRATION — doctrine enforced
// on the last hop before text reaches a human ready to paste — must be
// reinstated on the generation path in p2r-04. Until then the last gate is the
// owner's own eyes on the Telegram card.

const NOW = new Date("2026-07-27T15:00:00Z");

// Every Meta origin the parked client could reach. Anything landing here is a
// park leak, and the assertion names the URL so it is obvious which one.
const META_ORIGINS = ["https://graph.threads.net", "https://graph.threads.com", "https://threads.net"];
const metaCalls: string[] = [];

// env with posting armed. Parking must hold even when the master gate says go:
// THREADS_PARKED is checked FIRST precisely so a stray config flip cannot
// reach a banned account.
const postingEnv = () => Object.assign(Object.create(Object.getPrototypeOf(env)), env, { POSTING_ENABLED: "true" });

const TGRAM = { calls: [] as Array<{ path: string; body: Record<string, unknown> }> };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  // Catch-all tripwires. A parked path should never reach these; recording the
  // call rather than throwing means a leak fails with the offending URL in the
  // message instead of an opaque connect error swallowed by an inner catch.
  for (const origin of META_ORIGINS) {
    fetchMock
      .get(origin)
      .intercept({ path: /.*/, method: /.*/ })
      .reply(200, (opts) => {
        metaCalls.push(`${origin}${String(opts.path)}`);
        // Meta-shaped ERROR envelope, not an empty success body. thFetch
        // throws a ThreadsError on `body.error` regardless of status, so a
        // leak surfaces as a clean client error. An empty {data:[]} instead
        // makes refreshLongLived read expires_in as undefined, which builds
        // new Date(NaN) and throws RangeError mid-KV-write, leaving
        // miniflare's isolated-storage stack unpoppable — the test then
        // reports no verdict at all and blames storage instead of the leak.
        // code 1 is also what the live API actually returned during the ban.
        return JSON.stringify({ error: { code: 1, message: "park tripwire: this endpoint must not be reached" } });
      })
      .persist();
  }
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

beforeEach(() => {
  metaCalls.length = 0;
  TGRAM.calls.length = 0;
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
  const queueId = await createQueueEntry(env.DB, item.id ?? 0, "HALT", draft, NOW);
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

describe("the park", () => {
  it("is on — this assertion is the canary for un-parking by accident", () => {
    // Flipping THREADS_PARKED un-parks the platform. That is a deliberate
    // three-step act (this flag, the two jobs rows, a manual browser OAuth
    // round) and it should require editing this line consciously.
    expect(THREADS_PARKED).toBe(true);
  });

  it("runPoster touches NO Meta endpoint and publishes nothing, even fully armed", async () => {
    await connectThreads();
    const { queueId } = await seedApproved("PARK-1", "Something approved and ready, per Nasdaq");

    await runPoster(postingEnv(), NOW);

    expect(metaCalls, "parked poster reached a Meta endpoint").toEqual([]);
    // The load-bearing assertion: no claim row, so nothing published and
    // nothing stranded either.
    const claim = await env.DB.prepare("SELECT * FROM post_log WHERE queue_id = ?1").bind(queueId).first();
    expect(claim).toBeNull();
    // And the approval survives intact for the commentary pipeline to pick up.
    const row = await env.DB.prepare("SELECT state FROM queue WHERE id = ?1").bind(queueId).first<{ state: string }>();
    expect(row?.state).toBe("approved");
  });

  it("stays silent: no Telegram badge, no token alert, no Meta call", async () => {
    await connectThreads();
    await seedApproved("PARK-2", "Another approved draft, per Nasdaq");
    await runPoster(postingEnv(), NOW);
    // The metaCalls assertion is what makes this test park-sensitive. Telegram
    // silence alone is not: an un-parked poster hitting the tripwire gets a
    // ThreadsError with code 1, which is not token-invalid, so it logs and
    // moves on without ever reaching alertTokenInvalid. Asserting only
    // TGRAM.calls would pass with the park removed.
    expect(metaCalls, "parked poster reached a Meta endpoint").toEqual([]);
    expect(TGRAM.calls).toEqual([]);
  });

  it("leaves a pre-ban stranded claim exactly as it found it", async () => {
    // A claim with platform_post_id NULL is normally reconciled against the
    // account's own recent posts. That question cannot be answered now, so the
    // row must be left alone rather than released: releasing it would re-queue
    // a post that may well have gone out before the ban. Asserted so nobody
    // later "fixes" the reconciler back into life.
    await connectThreads();
    const { queueId } = await seedApproved("PARK-3", "Claimed just before the ban, per Nasdaq");
    await env.DB
      .prepare(
        `INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category)
         VALUES (?1, NULL, ?2, 'HALT', 'filing')`,
      )
      .bind(queueId, iso(new Date(NOW.getTime() - 600_000)))
      .run();

    await runPoster(postingEnv(), NOW);

    expect(metaCalls).toEqual([]);
    const still = await env.DB
      .prepare("SELECT platform_post_id FROM post_log WHERE queue_id = ?1")
      .bind(queueId)
      .first<{ platform_post_id: string | null }>();
    expect(still).not.toBeNull();
    expect(still?.platform_post_id).toBeNull();
  });

  it("preserves pre-ban post history while a publishable row sits next to it", async () => {
    // 18 real posts went out before the ban and their ids are history.
    //
    // Being precise about what each half of this proves, because the naive
    // version of this test proves nothing: a CONFIRMED claim is already
    // structurally unreachable — selection excludes it via
    // `LEFT JOIN post_log ... WHERE p.id IS NULL` and reconcileClaims only
    // reads `platform_post_id IS NULL` — so asserting it alone stays green
    // even with the park ripped out. The history assertion guards the
    // SELECTION QUERY against regression. The park is what the second row,
    // the publishable one, is here to test.
    //
    // connectThreads() is load-bearing: without stored auth runPoster returns
    // at the `if (!auth)` guard before any network path, and the whole test
    // would pass with the park removed.
    await connectThreads();
    const { queueId: historic } = await seedApproved("PARK-4", "Published before the ban, per Nasdaq");
    await env.DB
      .prepare(
        `INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category)
         VALUES (?1, 'THREADS_REAL_7', ?2, 'HALT', 'filing')`,
      )
      .bind(historic, iso(new Date(NOW.getTime() - 86_400_000)))
      .run();
    const { queueId: fresh } = await seedApproved("PARK-5", "Approved after the ban, per Nasdaq");

    await runPoster(postingEnv(), NOW);

    expect(metaCalls, "parked poster reached a Meta endpoint").toEqual([]);
    const row = await env.DB
      .prepare("SELECT platform_post_id FROM post_log WHERE queue_id = ?1")
      .bind(historic)
      .first<{ platform_post_id: string }>();
    expect(row?.platform_post_id).toBe("THREADS_REAL_7");
    expect(await env.DB.prepare("SELECT * FROM post_log WHERE queue_id = ?1").bind(fresh).first()).toBeNull();
  });

  it("refreshThreadsToken is inert and does not disturb the stored token", async () => {
    await connectThreads();
    // Far past the 7-day threshold: an unparked refresh would definitely fire.
    await refreshThreadsToken(postingEnv(), new Date(NOW.getTime() + 30 * 86_400_000));
    expect(metaCalls).toEqual([]);
    expect((await getThreadsAuth(env.KV))?.token).toBe("LONGTOKEN");
    expect(TGRAM.calls).toEqual([]);
  });

  it("the OAuth routes are unrouted", async () => {
    for (const path of ["/threads/oauth/start?key=test-webhook-secret", "/threads/oauth/callback?code=C&state=S"]) {
      const res = await SELF.fetch(`https://worker.local${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(404);
    }
    expect(metaCalls).toEqual([]);
  });
});

// The parked client stays on disk for the appeal, so its pure helpers keep
// their tests. These touch no network and document facts the ban record leans
// on.
describe("parked client: pure helpers still hold", () => {
  it("clampThreadsText caps at the verified 500-char limit, surrogate-safe", () => {
    expect(clampThreadsText("x".repeat(600)).length).toBe(THREADS_TEXT_LIMIT);
    expect(clampThreadsText("short")).toBe("short");
  });

  it("HTTP 500 + code 190 classifies as token-invalid, and code 1 does not", () => {
    // Why this matters to the ban record: the errors seen at 03:00Z were code
    // 1, NOT 190. That is how we tell a ban from an expired token.
    expect(new ThreadsError(190, "Invalid OAuth 2.0 Access Token", 500).isTokenInvalid).toBe(true);
    expect(new ThreadsError(4, "rate", 400).isTokenInvalid).toBe(false);
    expect(new ThreadsError(1, "An unknown error occurred", 500).isTokenInvalid).toBe(false);
  });

  it("storing auth clears the token-alert suppressor", async () => {
    await env.KV.put("threads:token_alert_sent", "1");
    await storeThreadsAuth(env.KV, { token: "T", userId: "77", expiresInSeconds: 60 * 86400, now: NOW });
    expect(await env.KV.get("threads:token_alert_sent")).toBeNull();
  });
});
