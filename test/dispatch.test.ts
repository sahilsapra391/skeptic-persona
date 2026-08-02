import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KILL_SWITCH_KEY,
  MAX_JOBS_PER_TICK,
  MAX_TICK_JOB_CONCURRENCY,
  registry,
  resolveConcurrency,
  tick,
} from "../src/dispatch";
import { fetchPool, MAX_CONCURRENT_FETCHES, newTickBudget, SEC_POOL_CONCURRENCY } from "../src/lib/budget";

// These tests own the jobs table; clear migration-seeded jobs (queue_expiry)
// so synthetic fixtures alone determine what each tick sees.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
});

const NOW = new Date("2026-07-22T14:00:00Z"); // Wed 10:00 EDT

/** p4-20: due_at now carries a per-job PHASE inside the interval, so a job of
 *  cadence `every_5m` reschedules somewhere near now+5m rather than to a round
 *  now+5m. Asserting the exact instant would pin the hash rather than the
 *  cadence, so assert the CONTRACT: advanced, and inside the one-time
 *  transition bound of [interval/2, 1.5*interval). The dispersion and the
 *  bound itself are pinned directly in test/cadence.test.ts. */
function expectRescheduledWithin(actual: string, now: Date, intervalMs: number) {
  const t = new Date(actual).getTime();
  expect(t).toBeGreaterThanOrEqual(now.getTime() + intervalMs / 2);
  expect(t).toBeLessThan(now.getTime() + intervalMs * 1.5);
}


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
    expectRescheduledWithin(await dueAtOf("a"), NOW, 5 * 60_000);
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
    expectRescheduledWithin(await dueAtOf("boom"), NOW, 5 * 60_000);
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
    expectRescheduledWithin(await dueAtOf("orphan"), NOW, 5 * 60_000);
  });

  it("a job due exactly at now runs (due_at <= now, not <)", async () => {
    const ran: string[] = [];
    registry["exact"] = async () => {
      ran.push("exact");
    };
    await seedJob("exact", "2026-07-22T14:00:00.000Z"); // == NOW
    await tick(env, NOW);
    expect(ran).toEqual(["exact"]);
    expectRescheduledWithin(await dueAtOf("exact"), NOW, 5 * 60_000);
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

describe("the dispatcher must actually pass the job name to nextDue (p4-20)", () => {
  it("two same-cadence jobs rescheduled by one tick do not land on the same due_at", async () => {
    // WIRING, not arithmetic. test/cadence.test.ts proves nextDue disperses
    // when handed a key — and every one of those tests passes the key itself,
    // so all of them stay green if the DISPATCHER stops passing row.name.
    // Deleting that argument was a mutation that nothing caught, which is the
    // same "fixed the call site, never pinned it" hole this repo has produced
    // four times tonight. This is the test that fails when the wiring goes.
    for (const n of ["twinjob_a", "twinjob_b", "twinjob_c"]) {
      registry[n] = async () => {};
      await seedJob(n, "2026-07-22T13:50:00.000Z"); // same cadence, same due_at
    }
    await tick(env, NOW);
    const due = await Promise.all(["twinjob_a", "twinjob_b", "twinjob_c"].map((n) => dueAtOf(n)));
    expect(new Set(due).size).toBe(3);
  });
});

describe("tick time budget", () => {
  it("stops starting new WAVES once the budget is spent, bounded by the concurrency", async () => {
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
    // CONTRACT CHANGE, stated rather than relaxed. Jobs now run concurrently
    // (p4-12), so the guard can only stop the NEXT wave: up to `concurrency`
    // jobs dispatch before any wall time has elapsed to measure. The bound
    // that matters is preserved — the tick cannot keep starting work
    // indefinitely — and the exposure is capped at the concurrency rather
    // than at one. That is tolerable here only because every handler is
    // idempotent via dedup, which is the same property the atomic claim
    // already relies on.
    const tiny = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
      TICK_TIME_BUDGET_MS: "10",
      TICK_JOB_CONCURRENCY: "2",
    });
    await tick(tiny, NOW);
    // Read the concurrency the tick RESOLVED rather than the one this test
    // tried to set. Asserting the hardcoded 2 passed 3/3 locally and failed on
    // CI with "expected 3 to be less than or equal to 2": the env override was
    // not visible to the Worker there, so the tick ran at the default 3. The
    // contract never changed — at most `concurrency` jobs start against a
    // spent budget — only this test's belief about what concurrency was.
    const effective = resolveConcurrency(tiny);
    expect(effective).toBeLessThanOrEqual(MAX_TICK_JOB_CONCURRENCY);
    expect(ran.length).toBeGreaterThanOrEqual(1); // something always progresses
    expect(ran.length).toBeLessThanOrEqual(effective); // and never more than the concurrency
  });

  it("runs jobs CONCURRENTLY, not one after another", async () => {
    // The whole point of p4-12: tick time was the SUM of network waits.
    let inFlight = 0;
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      const name = `parjob${i}`;
      registry[name] = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
      };
      await seedJob(name, `2026-07-22T13:1${i}:00.000Z`);
    }
    const env3 = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { TICK_JOB_CONCURRENCY: "3" });
    await tick(env3, NOW);
    expect(peak).toBeGreaterThan(1); // serial execution would peak at 1
    expect(peak).toBeLessThanOrEqual(3); // and never exceed the configured bound
  });

  it("one failing job does not void the rest of the tick", async () => {
    const ok: string[] = [];
    registry["boomjob"] = async () => {
      throw new Error("boom");
    };
    await seedJob("boomjob", "2026-07-22T13:20:00.000Z");
    for (let i = 0; i < 3; i++) {
      const name = `survivor${i}`;
      registry[name] = async () => {
        ok.push(name);
      };
      await seedJob(name, `2026-07-22T13:2${i + 1}:00.000Z`);
    }
    await tick(env, NOW);
    expect(ok.length).toBe(3);
    const row = await env.DB.prepare(`SELECT consecutive_failures AS f FROM jobs WHERE name = 'boomjob'`).first<{ f: number }>();
    expect(row?.f).toBe(1);
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
    const { results: out, errors } = await fetchPool(
      items,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return n * 2;
      },
      MAX_CONCURRENT_FETCHES,
    );
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_FETCHES);
    // Order preserved despite out-of-order completion.
    expect(out).toEqual(items.map((n) => n * 2));
    expect(errors).toEqual([]);
  });

  it("one throwing worker does not void the batch", async () => {
    // Each item is an independent filing; a single 503 must not discard the
    // other five results or abandon undispatched work.
    const { results, errors } = await fetchPool(
      [0, 1, 2, 3, 4],
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n * 10;
      },
      MAX_CONCURRENT_FETCHES,
    );
    expect(results).toEqual([0, 10, undefined, 30, 40]);
    expect(errors.map((e) => e.index)).toEqual([2]);
  });

  it("nested pools cannot exceed the platform's 6 connections to one host", () => {
    // Concurrency MULTIPLIES. The dispatcher runs jobs in a pool, and the three
    // SEC-hosted fan-out ingesters (13D/G, Form 144, Form 25) each open their
    // own pool inside their job. Left at fetchPool's default width that is
    // 3 x 6 = 18 simultaneous connections to www.sec.gov, against a source that
    // asks for <= 10 req/s and can block a User-Agent for ignoring it.
    //
    // The overlap is structural, not unlucky: all three carry cadence
    // `every_5m_us_0600_2200` and priority 50 (migrations 0012/0021/0035), so
    // they sort adjacently under the dispatcher's ORDER BY and land in the
    // same wave by construction.
    //
    // This asserts the PRODUCT, which is the only number that bounds the
    // connection count. Raising either constant alone turns it red.
    expect(MAX_TICK_JOB_CONCURRENCY * SEC_POOL_CONCURRENCY).toBeLessThanOrEqual(MAX_CONCURRENT_FETCHES);
  });
});

describe("time-budget exposure is bounded by the concurrency", () => {
  it("an already-spent budget lets at most `concurrency` jobs start", async () => {
    // The trade this design accepts, stated as an assertion rather than prose.
    //
    // Serially, the budget check ran between every job, so exactly one job
    // could overrun it. Concurrently, a whole wave passes the check before any
    // of them increments `ran`, so up to `concurrency` jobs can start against a
    // spent budget. That is the accepted cost of the rewrite — bounded, and
    // safe because ingesters are idempotent via dedup — but "bounded" is only
    // true while something pins the bound.
    //
    // Without the `ran > 0 && elapsed >= budget` guard, all 8 run.
    const started: string[] = [];
    for (let i = 0; i < 8; i++) {
      const name = `budgetjob${i}`;
      registry[name] = async () => {
        started.push(name);
        await new Promise((r) => setTimeout(r, 15));
      };
      await seedJob(name, "2026-07-22T13:30:00.000Z");
    }
    const tight = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
      TICK_TIME_BUDGET_MS: "1",
      TICK_JOB_CONCURRENCY: "2",
    });
    await tick(tight, NOW);
    // Same reason as above: the bound is whatever the tick resolved, not what
    // this test asked for.
    expect(started.length).toBeGreaterThan(0); // the first job is unconditional
    expect(started.length).toBeLessThanOrEqual(resolveConcurrency(tight)); // the wave is the bound
  });
});

describe("a claim failure must not be silent", () => {
  it("re-raises when the atomic claim throws, after the other jobs finish", async () => {
    // The claim UPDATE is the one statement in the worker body OUTSIDE the
    // handler's try/catch, so a D1 error there is not a job failing — it is D1
    // failing. fetchPool deliberately swallows worker rejections into `errors`
    // so one bad item cannot void the batch, which meant this class of failure
    // became invisible: `ran` stays 0, consecutive_failures is never
    // incremented (that bump lives in the handler catch, never reached), and
    // the `ran > 0` gate suppresses even the "tick complete" line. A tick that
    // claimed nothing reported nothing.
    //
    // src/index.ts depends on the opposite: "failures then land in the
    // dashboard's Past Events".
    const ok: string[] = [];
    registry["claimok"] = async () => {
      ok.push("claimok");
    };
    registry["claimboom"] = async () => {
      ok.push("claimboom");
    };
    await seedJob("claimok", "2026-07-22T13:40:00.000Z");
    await seedJob("claimboom", "2026-07-22T13:41:00.000Z");

    const realPrepare = env.DB.prepare.bind(env.DB);
    const brokenDb = {
      prepare(sql: string) {
        const stmt = realPrepare(sql);
        if (!sql.includes("UPDATE jobs SET due_at")) return stmt;
        return {
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args);
            return {
              async run() {
                if (args[1] === "claimboom") throw new Error("D1_ERROR: no such table");
                return bound.run();
              },
            };
          },
        };
      },
    };
    const brokenEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { DB: brokenDb });

    await expect(tick(brokenEnv, NOW)).rejects.toThrow(/failed outside the handler/);
    // The healthy job still ran: the throw happens after the pool drains, so
    // one broken claim does not abandon work that had already been claimed.
    expect(ok).toContain("claimok");
  });
});

describe("starvation guard", () => {
  async function seedJob(name: string, priority: number, dueAt: string) {
    await env.DB.prepare(
      `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES (?1, ?2, 'hourly', 1, ?3)
       ON CONFLICT(name) DO UPDATE SET due_at = excluded.due_at, priority = excluded.priority, enabled = 1`,
    )
      .bind(name, dueAt, priority)
      .run();
  }

  it("runs a long-starved low-priority job ahead of fresh high-priority work", async () => {
    // THE PRODUCTION BUG. The tick has a TIME budget as well as a count
    // limit, so when it breaks early it always breaks at the same place and
    // whatever sits below the cut never runs again. Observed 2026-07-28:
    // issuer_refresh (priority 90) had never run once, while priority-50 jobs
    // due every minute cycled ahead of it forever.
    const now = new Date("2026-07-28T16:00:00.000Z");
    await env.DB.prepare("DELETE FROM jobs").run();

    // The fixture MUST exceed MAX_JOBS_PER_TICK or this test proves nothing:
    // below the limit every seeded job runs whatever the ordering does, so the
    // guard is never the reason "starved" appears. That is not hypothetical —
    // it was seeded at a hardcoded 12 fresh jobs when the limit was 12, and
    // raising the limit to 24 silently disarmed it. Neutering the guard
    // (`WHEN due_at <= ?3 AND 0 THEN 1`) still left the suite green.
    //
    // So derive the count from the constant. If MAX_JOBS_PER_TICK moves again,
    // this fixture moves with it and the guard stays under test.
    const freshCount = MAX_JOBS_PER_TICK; // + the starved row = MAX + 1 total
    await seedJob("starved", 90, "2026-07-28T00:00:00.000Z"); // 16h overdue
    for (let i = 0; i < freshCount; i++) {
      await seedJob(`fresh_${i}`, 50, "2026-07-28T15:59:59.000Z"); // due this second
    }

    const ran: string[] = [];
    for (const name of ["starved", ...Array.from({ length: freshCount }, (_, i) => `fresh_${i}`)]) {
      registry[name] = async () => {
        ran.push(name);
      };
    }

    await tick(env as never, now);
    // Without the guard the starved job sorts last of MAX_JOBS_PER_TICK + 1
    // and is cut by the LIMIT before the time budget even matters.
    expect(ran).toContain("starved");
    // Anti-vacuity: prove the LIMIT actually bit. If everything ran, the
    // assertion above passes for a reason that has nothing to do with the
    // guard, which is exactly the failure this fixture just had.
    expect(ran.length).toBe(MAX_JOBS_PER_TICK);
  });

  it("leaves normal ordering alone when nothing is starving", async () => {
    const now = new Date("2026-07-28T16:00:00.000Z");
    await env.DB.prepare("DELETE FROM jobs").run();
    await seedJob("low", 90, "2026-07-28T15:59:00.000Z"); // 1 min overdue
    await seedJob("high", 10, "2026-07-28T15:59:00.000Z");

    const ran: string[] = [];
    for (const name of ["low", "high"]) {
      registry[name] = async () => {
        ran.push(name);
      };
    }
    await tick(env as never, now);
    // Neither is starving, so priority still decides who goes first.
    expect(ran[0]).toBe("high");
  });
});

describe("the starvation guard never delays latency-critical work", () => {
  it("keeps the poster first even when backlog has been starving for hours", async () => {
    const now = new Date("2026-07-28T16:00:00.000Z");
    await env.DB.prepare("DELETE FROM jobs").run();
    const ran: string[] = [];
    // Backlog starved far past STARVATION_MS, and enough of it to fill a tick.
    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      const name = `starving${String(i).padStart(2, "0")}`;
      registry[name] = async () => {
        ran.push(name);
      };
      await env.DB.prepare(
        "INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES (?1, ?2, 'hourly', 1, 90)",
      )
        .bind(name, "2026-07-20T00:00:00.000Z")
        .run();
    }
    registry["poster"] = async () => {
      ran.push("poster");
    };
    // Barely due, but latency-critical: worthless a minute late.
    await env.DB.prepare(
      "INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES ('poster', ?1, 'every_5m', 1, 0)",
    )
      .bind("2026-07-28T15:59:59.000Z")
      .run();

    await tick(env as never, now);
    expect(ran[0]).toBe("poster");
    // And the starving work still gets its turn in the same tick.
    expect(ran.length).toBeGreaterThan(1);
  });
});
