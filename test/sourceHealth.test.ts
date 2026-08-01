import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  formatHealth,
  healthReport,
  PROBE_AFTER_HOURS,
  QUARANTINE_AFTER,
  runSourceHealth,
  shouldQuarantine,
} from "../src/sourceHealth";

const NOW = new Date("2026-08-01T20:00:00.000Z");

async function seed(name: string, priority: number, fails: number, lastOkAt: string | null) {
  await env.DB.prepare(
    `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
     VALUES (?1, '2026-08-01T00:00:00.000Z', 'hourly', 1, ?2)
     ON CONFLICT(name) DO UPDATE SET enabled = 1, priority = excluded.priority`,
  )
    .bind(name, priority)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_state (source, consecutive_failures, last_ok_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(source) DO UPDATE SET consecutive_failures = excluded.consecutive_failures,
                                       last_ok_at = excluded.last_ok_at`,
  )
    .bind(name, fails, lastOkAt)
    .run();
}

async function jobRow(name: string) {
  return env.DB.prepare(`SELECT enabled, quarantined_at, quarantine_reason FROM jobs WHERE name = ?1`)
    .bind(name)
    .first<{ enabled: number; quarantined_at: string | null; quarantine_reason: string | null }>();
}

describe("shouldQuarantine needs BOTH a streak and silence", () => {
  it("quarantines an endpoint that has never answered", () => {
    // treasury_auction in production: 16 fails, last_ok never.
    expect(shouldQuarantine({ name: "t", fails: 16, lastOkAt: null }, NOW)).toBe(true);
  });

  it("does NOT quarantine a source that answered recently, whatever its streak", () => {
    // rate_boe carries a failure run most mornings from overnight UK
    // maintenance and answers again by midday. A streak-only rule would
    // silence a working source.
    expect(shouldQuarantine({ name: "boe", fails: 99, lastOkAt: "2026-08-01T14:51:00.000Z" }, NOW)).toBe(false);
  });

  it("does not act on a short streak", () => {
    expect(shouldQuarantine({ name: "x", fails: QUARANTINE_AFTER - 1, lastOkAt: null }, NOW)).toBe(false);
  });

  it("treats an unreadable last_ok_at as silence, not as recent success", () => {
    // Failing open here would keep a dead source alive forever.
    expect(shouldQuarantine({ name: "x", fails: 20, lastOkAt: "not-a-date" }, NOW)).toBe(true);
  });
});

describe("runSourceHealth", () => {
  it("quarantines the dead source and leaves the recovering one alone", async () => {
    await env.DB.prepare("DELETE FROM jobs").run();
    await seed("dead_source", 50, 16, null);
    await seed("recovering_source", 50, 14, "2026-08-01T14:51:00.000Z");

    await runSourceHealth(env as never, NOW);

    const dead = await jobRow("dead_source");
    expect(dead?.enabled).toBe(0);
    expect(dead?.quarantined_at).toBeTruthy();
    expect(dead?.quarantine_reason).toContain("never");

    expect((await jobRow("recovering_source"))?.enabled).toBe(1);
  });

  it("never silences latency-critical work automatically", async () => {
    // Same exemption as the starvation guard: the poster and the release
    // watchers ARE the pipeline. Turning one off without a human is never
    // the right call, however dead its endpoint looks.
    await env.DB.prepare("DELETE FROM jobs").run();
    await seed("poster", 0, 500, null);
    await runSourceHealth(env as never, NOW);
    expect((await jobRow("poster"))?.enabled).toBe(1);
  });

  it("releases a quarantined source for one real attempt, then re-quarantines it", async () => {
    await env.DB.prepare("DELETE FROM jobs").run();
    await seed("flapper", 50, 16, null);

    await runSourceHealth(env as never, NOW);
    expect((await jobRow("flapper"))?.enabled).toBe(0);

    // Too soon: still quarantined.
    await runSourceHealth(env as never, new Date(NOW.getTime() + 3_600_000));
    expect((await jobRow("flapper"))?.enabled).toBe(0);

    // Past the probe window: back on, and due immediately.
    const later = new Date(NOW.getTime() + (PROBE_AFTER_HOURS + 1) * 3_600_000);
    await runSourceHealth(env as never, later);
    const released = await jobRow("flapper");
    expect(released?.enabled).toBe(1);
    expect(released?.quarantined_at).toBeNull();

    // The endpoint is still dead, so the streak is untouched and the next
    // pass puts it back. One fetch per probe window, not one per tick.
    await runSourceHealth(env as never, later);
    expect((await jobRow("flapper"))?.enabled).toBe(0);
  });
});

describe("healthReport", () => {
  it("lists only what is not clean, worst first, and says so when all is well", async () => {
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM source_state").run();
    await seed("healthy", 50, 0, "2026-08-01T19:00:00.000Z");
    expect(await healthReport(env as never)).toEqual([]);
    expect(formatHealth([], NOW)).toContain("All sources healthy");

    await seed("sick", 50, 16, null);
    const rows = await healthReport(env as never);
    expect(rows.map((r) => r.name)).toEqual(["sick"]);

    const text = formatHealth(rows, NOW);
    expect(text).toContain("sick");
    expect(text).toContain("never succeeded");
    // Telegram runs without parse_mode in this project, so the report must
    // carry no markdown that would need escaping.
    expect(text).not.toMatch(/[*_`[\]]/);
  });
});
