import type { Env } from "./env";
import { tick } from "./dispatch";
import { registerJobs } from "./jobs";
import { handleTelegramWebhook, WEBHOOK_PATH } from "./telegram/webhook";
import { handleIngestRelay, INGEST_PATH } from "./ingestRelay";
import { handleSeedTest } from "./admin";
import { handleOauthCallback, handleOauthStart, OAUTH_CALLBACK_PATH, OAUTH_START_PATH } from "./threadsOauth";
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
    if (request.method === "POST" && url.pathname === INGEST_PATH) {
      return handleIngestRelay(request, env);
    }
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      return handleTelegramWebhook(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/seed-test") {
      return handleSeedTest(request, env);
    }
    if (request.method === "GET" && url.pathname === OAUTH_START_PATH) {
      return handleOauthStart(request, env);
    }
    if (request.method === "GET" && url.pathname === OAUTH_CALLBACK_PATH) {
      return handleOauthCallback(request, env);
    }
    log("debug", "unhandled request", { path: url.pathname, method: request.method });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
