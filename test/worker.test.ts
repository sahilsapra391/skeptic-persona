import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { registry } from "../src/dispatch";

describe("worker scheduled handler", () => {
  afterEach(() => {
    delete registry["sched_probe"];
  });

  it("the cron entrypoint runs the dispatcher against due jobs", async () => {
    const ran: string[] = [];
    registry["sched_probe"] = async () => {
      ran.push("sched_probe");
    };
    await env.DB.prepare(
      "INSERT INTO jobs (name, due_at, cadence_profile) VALUES ('sched_probe', '2026-07-22T13:59:00.000Z', 'every_5m')",
    ).run();

    await (
      SELF as unknown as { scheduled: (o: { scheduledTime: number; cron: string }) => Promise<unknown> }
    ).scheduled({ scheduledTime: new Date("2026-07-22T14:00:00Z").getTime(), cron: "* * * * *" });

    expect(ran).toEqual(["sched_probe"]);
    const row = await env.DB.prepare("SELECT due_at FROM jobs WHERE name = 'sched_probe'").first<{
      due_at: string;
    }>();
    expect(row?.due_at).toBe("2026-07-22T14:05:00.000Z");
  });
});

describe("worker fetch handler", () => {
  it("serves /health", async () => {
    const res = await SELF.fetch("https://worker.local/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; now: string }>();
    expect(body.ok).toBe(true);
    expect(new Date(body.now).getTime()).not.toBeNaN();
  });

  it("404s everything else for now", async () => {
    const res = await SELF.fetch("https://worker.local/anything");
    expect(res.status).toBe(404);
  });
});
