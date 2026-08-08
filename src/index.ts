import type { Env } from "./env";
import { tick } from "./dispatch";
import { registerJobs } from "./jobs";
import { handleTelegramWebhook, WEBHOOK_PATH } from "./telegram/webhook";
import {
  handleIngestPending,
  handleIngestRelay,
  handlePressPending,
  INGEST_PATH,
  PENDING_PATH,
  PRESS_PENDING_PATH,
} from "./ingestRelay";
import { handleCredCheck, handleGenerationHistory, handleProbe, handleSeedTest } from "./admin";
// src/threadsOauth.ts is intentionally left on disk but UNROUTED: the Threads
// account is banned (poster.ts THREADS_PARKED). Re-import and re-add the two
// routes below if the appeal succeeds; reconnecting needs a manual browser
// round because a dead long-lived token cannot be refreshed.
import { log } from "./lib/log";

registerJobs();

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Single cron ("* * * * *"); all real scheduling lives in the D1 jobs
    // table. Awaited directly: the runtime waits on the returned promise for
    // cron events, and failures then land in the dashboard's Past Events.
    await tick(env, new Date(controller.scheduledTime));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, now: new Date().toISOString() });
    }
    if (request.method === "GET" && url.pathname === PRESS_PENDING_PATH) {
      return handlePressPending(request, env);
    }
    if (request.method === "GET" && url.pathname === PENDING_PATH) {
      return handleIngestPending(request, env);
    }
    if (request.method === "POST" && url.pathname === INGEST_PATH) {
      return handleIngestRelay(request, env);
    }
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      return handleTelegramWebhook(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/seed-test") {
      return handleSeedTest(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/credcheck") {
      // B-14.1: proves a credential WORKS against the deployed target, which
      // is a different claim from "the put succeeded" (D-56).
      return handleCredCheck(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/probe") {
      return handleProbe(request, env);
    }
    if (request.method === "GET" && url.pathname === "/admin/generations") {
      return handleGenerationHistory(request, env);
    }
    log("debug", "unhandled request", { path: url.pathname, method: request.method });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
