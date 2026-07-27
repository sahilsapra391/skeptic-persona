import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KILL_SWITCH_KEY, MAX_JOBS_PER_TICK, registry, tick } from "../src/dispatch";

// These tests own the jobs table; clear migration-seeded jobs (queue_expiry)
// so synthetic fixtures alone determine what each tick sees.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
});

const NOW = new Date("2026-07-22T14:00:00Z"); // Wed 10:00 EDT

async function seedJob(name: string, dueAt: string, profile = "every_5m", enabled = 1) {
  await env.DB.prepare("INSERT INTO jobs (name, due_at, cadence_profile, enabled) VALUES (?1, ?2, ?3, ?4)")
    .bind(name, dueAt, profile, enabled)
    .run();
}

async function dueAtOf(name: string): Promise<string> {
  const row = await env.DB.prepare("SELECT due_at FROM jobs WHERE name = ?1").bind(name).first<{ due_at: string }>();
  return row?.due_at ?? "";
}

afterEach(async () => {
  for (const k of Object.keys(registry)) delete registry[k];
  await env.KV.delete(KILL_SWITCH_KEY);
});

describe("tick", () => {
  it("runs due jobs and reschedules them via their cadence profile", async () => {
    const ran: string[] = [];
    registry["a"] = async () => {
      ran.push("a");
    };
    await seedJob("a", "2026-07-22T13:59:00.000Z");
    await seedJob("future", "2026-07-22T15:00:00.000Z");
    registry["future"] = async () => {
      ran.push("future");
    };

    await tick(env, NOW);

    expect(ran).toEqual(["a"]);
    expect(await dueAtOf("a")).toBe("2026-07-22T14:05:00.000Z");
    expect(await dueAtOf("future")).toBe("2026-07-22T15:00:00.000Z");
  });

  it("a crashing job is rescheduled and does not break the tick", async () => {
    const ran: string[] = [];
    registry["boom"] = async () => {
      throw new Error("parse failed");
    };
    registry["ok"] = async () => {
      ran.push("ok");
    };
    await seedJob("boom", "2026-07-22T13:00:00.000Z");
    await seedJob("ok", "2026-07-22T13:30:00.000Z");

    await tick(env, NOW);

    expect(ran).toEqual(["ok"]);
    // Rescheduled BEFORE running: no every-minute retry hammering a source.
    expect(await dueAtOf("boom")).toBe("2026-07-22T14:05:00.000Z");
  });

  it("caps work per tick at MAX_JOBS_PER_TICK, oldest due first", async () => {
    const ran: string[] = [];
    for (let i = 0; i < MAX_JOBS_PER_TICK + 2; i++) {
      const name = `j${i}`;
      registry[name] = async () => {
        ran.push(name);
      };
      // j0 oldest ... j5 newest
      await seedJob(name, `2026-07-22T13:0${i}:00.000Z`);
    }

    await tick(env, NOW);
    expect(ran).toEqual(["j0", "j1", "j2", "j3"]);

    // Leftovers run on the next tick.
    await tick(env, NOW);
    expect(ran).toEqual(["j0", "j1", "j2", "j3", "j4", "j5"]);
  });

  it("skips disabled jobs and unknown handlers without crashing", async () => {
    await seedJob("disabled", "2026-07-22T13:00:00.000Z", "every_5m", 0);
    await seedJob("orphan", "2026-07-22T13:00:00.000Z"); // no registry entry
    await tick(env, NOW);
    expect(await dueAtOf("disabled")).toBe("2026-07-22T13:00:00.000Z");
    // Orphan still gets rescheduled (so a bad deploy can't hot-loop it).
    expect(await dueAtOf("orphan")).toBe("2026-07-22T14:05:00.000Z");
  });

  it("a job due exactly at now runs (due_at <= now, not <)", async () => {
    const ran: string[] = [];
    registry["exact"] = async () => {
      ran.push("exact");
    };
    await seedJob("exact", "2026-07-22T14:00:00.000Z"); // == NOW
    await tick(env, NOW);
    expect(ran).toEqual(["exact"]);
    expect(await dueAtOf("exact")).toBe("2026-07-22T14:05:00.000Z");
  });

  it("overlapping invocations cannot double-run a job (atomic claim)", async () => {
    const ran: string[] = [];
    let reentered = false;
    // "slow" simulates a handler still in flight when the next cron fires:
    // it triggers a nested tick before finishing, like a stalled fetch would.
    registry["slow"] = async (envArg) => {
      if (!reentered) {
        reentered = true;
        await tick(envArg, NOW);
      }
      ran.push("slow");
    };
    registry["b"] = async () => {
      ran.push("b");
    };
    await seedJob("slow", "2026-07-22T13:00:00.000Z");
    await seedJob("b", "2026-07-22T13:30:00.000Z");

    await tick(env, NOW);

    // The inner (overlapping) tick claimed and ran "b"; the outer tick's
    // stale claim on "b" must fail, so "b" runs exactly once.
    expect(ran.filter((n) => n === "b")).toHaveLength(1);
    expect(ran.filter((n) => n === "slow")).toHaveLength(1);
  });

  it("kill switch halts everything", async () => {
    const ran: string[] = [];
    registry["a"] = async () => {
      ran.push("a");
    };
    await seedJob("a", "2026-07-22T13:00:00.000Z");
    await env.KV.put(KILL_SWITCH_KEY, "1");

    await tick(env, NOW);

    expect(ran).toEqual([]);
    expect(await dueAtOf("a")).toBe("2026-07-22T13:00:00.000Z");
  });
});

describe("tick time budget", () => {
  it("stops starting new jobs once the budget is spent, but always runs at least one", async () => {
    const ran: string[] = [];
    for (let i = 0; i < 3; i++) {
      const name = `slowjob${i}`;
      registry[name] = async () => {
        ran.push(name);
        // Burn wall time so the guard trips for the next candidate.
        await new Promise((r) => setTimeout(r, 30));
      };
      await seedJob(name, `2026-07-22T13:0${i}:00.000Z`);
    }
    const tiny = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { TICK_TIME_BUDGET_MS: "10" });
    await tick(tiny, NOW);
    // First job always runs (otherwise nothing would ever progress); the rest
    // defer rather than risk being killed mid-flight.
    expect(ran.length).toBe(1);
  });

  it("a generous budget lets the full tick run", async () => {
    const ran: string[] = [];
    for (let i = 0; i < 3; i++) {
      const name = `fastjob${i}`;
      registry[name] = async () => {
        ran.push(name);
      };
      await seedJob(name, `2026-07-22T13:0${i}:00.000Z`);
    }
    await tick(env, NOW);
    expect(ran.length).toBe(3);
  });
});
