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
