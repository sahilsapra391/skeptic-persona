import type { Env } from "./env";
import { insertItem, SCORE_POSTABLE } from "./lib/db";
import { enqueueForApproval } from "./pipeline/enqueue";
import { safeEqual } from "./telegram/webhook";
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
