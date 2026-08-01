import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { putSourceState } from "../src/lib/db";
import { iso } from "../src/lib/time";
import {
  formatHealth,
  healthReport,
  PROBE_AFTER_HOURS,
  QUARANTINE_AFTER,
  MIN_DEAD_AGE_HOURS,
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

describe("the review findings, pinned", () => {
  it("quarantines on the streak alone when the source has NEVER succeeded", () => {
    // The two real targets. An endpoint that has failed this many times and
    // never once answered is not having a bad week, and disabling it forfeits
    // nothing because there is no working behaviour to lose.
    expect(shouldQuarantine({ name: "treasury_auction", fails: 16, lastOkAt: null }, NOW)).toBe(true);
    // press_cftc_enforcement's REAL production value is 6, which is under the
    // threshold and correctly NOT caught. Substituting 12 here would have
    // dressed the rule in evidence it does not have.
    expect(shouldQuarantine({ name: "press_cftc_real", fails: 6, lastOkAt: null }, NOW)).toBe(false);
    expect(shouldQuarantine({ name: "press_cftc_later", fails: 12, lastOkAt: null }, NOW)).toBe(true);
    // The streak floor still applies.
    expect(shouldQuarantine({ name: "x", fails: 11, lastOkAt: null }, NOW)).toBe(false);
  });

  it("survives every legitimate silence a working source can have", () => {
    // Each of these would have tripped an earlier version of the rule. 12h
    // was satisfied by any weekend; 72h by a weekly cadence or a holiday
    // closure with a weekend attached. Tuning one constant against the worst
    // cadence was the wrong shape.
    const cases: [string, string, string][] = [
      ["closed weekend", "2026-07-31T20:00:00.000Z", "2026-08-03T13:00:00.000Z"],
      ["weekly cftc_cot", "2026-07-25T15:30:00.000Z", "2026-08-01T20:00:00.000Z"],
      ["Thanksgiving + weekend", "2026-11-25T20:00:00.000Z", "2026-11-30T14:00:00.000Z"],
      ["Christmas closure", "2026-12-24T18:00:00.000Z", "2026-12-29T14:00:00.000Z"],
    ];
    for (const [label, lastOk, when] of cases) {
      expect(shouldQuarantine({ name: label, fails: 99, lastOkAt: lastOk }, new Date(when)), label).toBe(false);
    }
    // Two weeks dead, having previously worked: now it goes.
    expect(
      shouldQuarantine({ name: "long dead", fails: 99, lastOkAt: "2026-07-10T00:00:00.000Z" }, new Date("2026-08-01T00:00:00.000Z")),
    ).toBe(true);
  });

  it("does not quarantine a market-hours source over a closed weekend", async () => {
    // halts_nasdaq is priority 50, so the CRITICAL_PRIORITY exemption does
    // NOT cover it. Carrying a failure streak into a closed weekend leaves it
    // legitimately silent for ~64 hours. At the old 12-hour threshold the
    // silence test was satisfied by every weekend, collapsing the rule to the
    // streak-only version the PR itself calls unsafe.
    const fridayFail = { name: "halts_nasdaq", fails: 20, lastOkAt: "2026-07-31T20:00:00.000Z" };
    const mondayOpen = new Date("2026-08-03T13:00:00.000Z"); // ~65h later
    expect(shouldQuarantine(fridayFail, mondayOpen)).toBe(false);

    // A genuinely dead endpoint is still caught, three days later.
    expect(shouldQuarantine({ ...fridayFail, lastOkAt: null }, mondayOpen)).toBe(true);
  });

  it("keeps a deliberately pinned schedule when it releases a probe", async () => {
    // treasury_auction and press_cftc_enforcement were moved to
    // daily_1330_utc with a pinned due_at by migrations 0024 and 0034, so a
    // permanently dead endpoint costs one fetch a day. Writing the probe
    // instant into due_at resurrected them onto a faster cadence and undid
    // those parks -- the automatic layer overruling a human decision.
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare(
      `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
       VALUES ('treasury_auction', '2026-08-02T13:30:00.000Z', 'daily_1330_utc', 1, 50)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO source_state (source, consecutive_failures, last_ok_at)
       VALUES ('treasury_auction', 16, NULL)`,
    ).run();

    await runSourceHealth(env as never, NOW);
    const later = new Date(NOW.getTime() + (PROBE_AFTER_HOURS + 1) * 3_600_000);
    await runSourceHealth(env as never, later);

    const row = await env.DB.prepare(`SELECT enabled, due_at FROM jobs WHERE name = 'treasury_auction'`)
      .first<{ enabled: number; due_at: string }>();
    expect(row?.enabled).toBe(1);
    // Re-enabled at its OWN slot, not dragged onto the probe instant.
    expect(row?.due_at).toBe("2026-08-02T13:30:00.000Z");
  });

  it("does not report a manual park as a quarantine", async () => {
    // Migration 0026 disabled poster and threads_token_refresh by hand for
    // the Threads ban. Both carry NULL quarantine_reason. Calling those
    // QUARANTINED tells the owner a product decision he made was an outage.
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM source_state").run();
    await env.DB.prepare(
      `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
       VALUES ('poster', '2026-08-01T00:00:00.000Z', 'every_5m', 0, 0)`,
    ).run();

    const text = formatHealth(await healthReport(env as never, NOW), NOW);
    expect(text).toContain("poster");
    expect(text).toContain("disabled (manual)");
    expect(text).not.toContain("poster: QUARANTINED");
  });
});

describe("healthReport", () => {
  it("surfaces a job that is overdue and has never succeeded, even with no source_state", async () => {
    // The blind spot the source-keyed query could not see. queue_expiry,
    // generation and bls_watch have NO source_state row at all, so a report
    // joined on source is blind to them however broken they are.
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM source_state").run();
    await env.DB.prepare(
      `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority, last_ok_at)
       VALUES ('never_ran', '2026-08-01T10:00:00.000Z', 'hourly', 1, 50, NULL)`,
    ).run();
    // Legitimately scheduled ahead: bls_watch really is due 2026-08-04
    // against a BLS release window, and flagging it would be a false alarm
    // in a report whose value is being quiet when things are fine.
    await env.DB.prepare(
      `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority, last_ok_at)
       VALUES ('not_due_yet', '2026-08-04T13:58:30.000Z', 'every_30m', 1, 10, NULL)`,
    ).run();

    const names = (await healthReport(env as never, NOW)).map((r) => r.name);
    expect(names).toContain("never_ran");
    expect(names).not.toContain("not_due_yet");
  });

  it("lists only what is not clean, worst first, and says so when all is well", async () => {
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM source_state").run();
    await seed("healthy", 50, 0, "2026-08-01T19:00:00.000Z");
    await env.DB.prepare(`UPDATE jobs SET last_ok_at = ?1 WHERE name = 'healthy'`)
      .bind("2026-08-01T19:00:00.000Z")
      .run();
    expect(await healthReport(env as never, NOW)).toEqual([]);
    expect(formatHealth([], NOW)).toContain("All sources healthy");

    await seed("sick", 50, 16, null);
    await env.DB.prepare(`UPDATE jobs SET last_ok_at = ?1 WHERE name = 'sick'`)
      .bind("2026-08-01T19:00:00.000Z")
      .run();
    const rows = await healthReport(env as never, NOW);
    expect(rows.map((r) => r.name)).toEqual(["sick"]);

    const text = formatHealth(rows, NOW);
    expect(text).toContain("sick");
    expect(text).toContain("never succeeded");
    // Telegram runs without parse_mode in this project, so the report must
    // carry no markdown that would need escaping.
    expect(text).not.toMatch(/[*_`[\]]/);
  });
});

describe("the probe leaves no tombstone", () => {
  it("clears quarantine_reason too, so a later manual park is not mislabelled", async () => {
    // quarantine_reason is formatHealth's ONLY manual-vs-automatic
    // discriminator. Leaving it behind means a source that recovers and is
    // later parked BY HAND still reports QUARANTINED, from an outage that
    // ended.
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM source_state").run();
    await seed("recovers_then_parked", 50, 16, null);

    await runSourceHealth(env as never, NOW);
    const later = new Date(NOW.getTime() + (PROBE_AFTER_HOURS + 1) * 3_600_000);
    await runSourceHealth(env as never, later);

    const row = await env.DB.prepare(
      `SELECT enabled, quarantined_at, quarantine_reason FROM jobs WHERE name = 'recovers_then_parked'`,
    ).first<{ enabled: number; quarantined_at: string | null; quarantine_reason: string | null }>();
    expect(row?.enabled).toBe(1);
    expect(row?.quarantined_at).toBeNull();
    expect(row?.quarantine_reason).toBeNull();

    // Now a human parks it. It must read as manual, not as an outage.
    await env.DB.prepare(`UPDATE jobs SET enabled = 0 WHERE name = 'recovers_then_parked'`).run();
    const text = formatHealth(await healthReport(env as never, later), later);
    expect(text).toContain("disabled (manual)");
    expect(text).not.toContain("recovers_then_parked: QUARANTINED");
  });
});

describe("a young source is not a dead one", () => {
  it("does not quarantine a source that has only just started failing", () => {
    // source_state's row is created on the FIRST failure, so before
    // first_failure_at existed, a source deployed into a transient 503 on an
    // every_1m cadence hit twelve failures twelve minutes later and was
    // quarantined before anyone had looked at it. The streak was real; the
    // inference was not.
    const justDeployed = {
      name: "brand_new",
      fails: 12,
      lastOkAt: null,
      firstFailureAt: "2026-08-01T19:48:00.000Z",
    };
    expect(shouldQuarantine(justDeployed, new Date("2026-08-01T20:00:00.000Z"))).toBe(false);

    // A day later, still nothing but failures: now the streak means something.
    expect(shouldQuarantine(justDeployed, new Date("2026-08-02T20:00:00.000Z"))).toBe(true);
  });

  it("still catches a legacy row, where absence of a start time means OLD", () => {
    // Every row that exists when the column lands has NULL here, and those
    // are exactly the long-running failures this was built for.
    // treasury_auction had been failing for days before it shipped.
    expect(
      shouldQuarantine({ name: "treasury_auction", fails: 16, lastOkAt: null, firstFailureAt: null }, NOW),
    ).toBe(true);
    // Same when the field is simply absent from the row shape.
    expect(shouldQuarantine({ name: "legacy", fails: 16, lastOkAt: null }, NOW)).toBe(true);
  });

  it("stamps, preserves and clears first_failure_at without any caller doing so", async () => {
    // Maintained in SQL inside putSourceState, because 'also stamp a
    // timestamp' is a rule one of thirty ingesters eventually forgets.
    const t0 = new Date("2026-08-01T10:00:00.000Z");
    const base = {
      source: "stamp_test",
      etag: null,
      lastModified: null,
      cursor: null,
      lastPolledAt: iso(t0),
      lastOkAt: null,
    };
    await putSourceState(env.DB, { ...base, consecutiveFailures: 1 }, t0);
    const read = async () =>
      (await env.DB.prepare(`SELECT first_failure_at AS f FROM source_state WHERE source = 'stamp_test'`)
        .first<{ f: string | null }>())!.f;
    expect(await read()).toBe(iso(t0));

    // A later failure in the same run must NOT move the start.
    const t1 = new Date("2026-08-01T14:00:00.000Z");
    await putSourceState(env.DB, { ...base, consecutiveFailures: 5 }, t1);
    expect(await read()).toBe(iso(t0));

    // Success clears it, so the next run starts its own clock.
    await putSourceState(env.DB, { ...base, consecutiveFailures: 0, lastOkAt: iso(t1) }, t1);
    expect(await read()).toBeNull();

    const t2 = new Date("2026-08-02T09:00:00.000Z");
    await putSourceState(env.DB, { ...base, consecutiveFailures: 1 }, t2);
    expect(await read()).toBe(iso(t2));
  });
});

describe("a legacy row stays catchable", () => {
  it("quarantines a pre-column row seeded straight into D1, not just in the pure function", async () => {
    // Requested during review, and it is the assertion that fails loudly if
    // someone later "tidies up" the null handling. Every row that existed
    // when first_failure_at landed has NULL there, and those are exactly the
    // long-running failures this chunk was built for. Read the other way --
    // null as "brand new" -- and the whole quarantine silently stops working
    // for precisely the sources it exists to catch.
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM source_state").run();
    await env.DB.prepare(
      `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
       VALUES ('legacy_dead', '2026-08-01T00:00:00.000Z', 'hourly', 1, 50)`,
    ).run();
    // Written WITHOUT first_failure_at, exactly as a pre-migration row reads.
    await env.DB.prepare(
      `INSERT INTO source_state (source, consecutive_failures, last_ok_at)
       VALUES ('legacy_dead', 16, NULL)`,
    ).run();
    const before = await env.DB.prepare(
      `SELECT first_failure_at AS f FROM source_state WHERE source = 'legacy_dead'`,
    ).first<{ f: string | null }>();
    expect(before?.f).toBeNull();

    await runSourceHealth(env as never, NOW);

    const row = await env.DB.prepare(`SELECT enabled, quarantine_reason FROM jobs WHERE name = 'legacy_dead'`)
      .first<{ enabled: number; quarantine_reason: string | null }>();
    expect(row?.enabled).toBe(0);
    expect(row?.quarantine_reason).toContain("never");
  });
});
