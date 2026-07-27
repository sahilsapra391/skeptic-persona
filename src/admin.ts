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
  const queueId = await enqueueForApproval(
    env,
    item.id,
    "SMOKE_TEST",
    `Smoke test draft (${iso(now)}). Tap any button — nothing posts anywhere.`,
    "https://www.example.gov/smoke-test",
    now,
  );
  return Response.json({ ok: true, queueId });
}
