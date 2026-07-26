import type { Env } from "./env";
import { tick } from "./dispatch";
import { log } from "./lib/log";

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Single cron ("* * * * *"); all real scheduling lives in the D1 jobs
    // table. Awaited directly: the runtime waits on the returned promise for
    // cron events, and failures then land in the dashboard's Past Events.
    await tick(env, new Date(controller.scheduledTime));
  },

  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, now: new Date().toISOString() });
    }
    // Telegram webhook route lands here in PR-2.
    log("debug", "unhandled request", { path: url.pathname, method: request.method });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
