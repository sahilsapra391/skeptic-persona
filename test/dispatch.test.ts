import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KILL_SWITCH_KEY, MAX_JOBS_PER_TICK, registry, tick } from "../src/dispatch";
import { fetchPool, MAX_CONCURRENT_FETCHES, newTickBudget } from "../src/lib/budget";

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
    const total = MAX_JOBS_PER_TICK + 2;
    const names = Array.from({ length: total }, (_, i) => `j${String(i).padStart(2, "0")}`);
    for (const [i, name] of names.entries()) {
      registry[name] = async () => {
        ran.push(name);
      };
      // Minute-spaced so lexical due_at ordering matches the array order.
      await seedJob(name, `2026-07-22T13:${String(i).padStart(2, "0")}:00.000Z`);
    }

    await tick(env, NOW);
    expect(ran).toEqual(names.slice(0, MAX_JOBS_PER_TICK));

    // Leftovers run on the next tick.
    await tick(env, NOW);
    expect(ran).toEqual(names);
  });

  it("priority outranks due_at: the poster never queues behind stale backlog", async () => {
    const ran: string[] = [];
    // Backlog older than the priority job, and enough of it to fill the tick.
    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      const name = `backlog${String(i).padStart(2, "0")}`;
      registry[name] = async () => {
        ran.push(name);
      };
      await seedJob(name, `2026-07-22T12:${String(i).padStart(2, "0")}:00.000Z`);
    }
    registry["poster"] = async () => {
      ran.push("poster");
    };
    // Due LAST by time, but priority 0.
    await env.DB.prepare(
      "INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES (?1, ?2, 'every_5m', 1, 0)",
    )
      .bind("poster", "2026-07-22T13:59:00.000Z")
      .run();

    await tick(env, NOW);
    expect(ran[0]).toBe("poster");
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

describe("paid-tier budget", () => {
  it("reserves fetches so ingester backlog cannot starve the poster", () => {
    const b = newTickBudget(200);
    // Unreserved callers see 180 of 200; the last 20 are for priority work.
    expect(b.remaining()).toBe(180);
    expect(b.remaining({ reserved: true })).toBe(200);
    expect(b.take(180)).toBe(true);
    expect(b.take(1)).toBe(false); // ingester hits the floor
    expect(b.take(1, { reserved: true })).toBe(true); // poster still can
  });

  it("the reserve scales down so small budgets stay usable", () => {
    // A flat reserve would swallow a tiny budget whole and deadlock the tick.
    const tiny = newTickBudget(1);
    expect(tiny.take(1)).toBe(true);
  });

  it("fetchPool bounds concurrency at the platform's 6 connections", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await fetchPool(items, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_FETCHES);
    // Order preserved despite out-of-order completion.
    expect(out).toEqual(items.map((n) => n * 2));
  });
});
