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

describe("a legacy row keeps its NULL through further failures", () => {
  it("does not hand the longest-dead source a fresh clock", async () => {
    // The defect: putSourceState stamped whenever first_failure_at was NULL
    // and failures were non-zero, which caught a LEGACY row mid-streak and
    // dated it today. Those rows are exactly the long-dead sources the
    // quarantine exists for, so the effect was a day of immunity for the
    // worst offender in the fleet. Reproduced against a production-shaped
    // treasury_auction row.
    await env.DB.prepare("DELETE FROM source_state").run();
    await env.DB.prepare(
      `INSERT INTO source_state (source, consecutive_failures, last_ok_at)
       VALUES ('treasury_auction', 16, NULL)`,
    ).run();

    const read = async () =>
      (await env.DB.prepare(
        `SELECT first_failure_at AS f, consecutive_failures AS n FROM source_state WHERE source = 'treasury_auction'`,
      ).first<{ f: string | null; n: number }>())!;
    expect((await read()).f).toBeNull();

    // One more failing poll, exactly as the ingester writes it.
    const later = new Date("2026-08-02T13:30:00.000Z");
    await putSourceState(
      env.DB,
      {
        source: "treasury_auction",
        etag: null,
        lastModified: null,
        cursor: null,
        lastPolledAt: iso(later),
        lastOkAt: null,
        consecutiveFailures: 17,
      },
      later,
    );

    const after = await read();
    expect(after.n).toBe(17);
    // Still NULL: absence continues to mean OLD, which is what 0048 claims.
    expect(after.f).toBeNull();
    expect(shouldQuarantine({ name: "treasury_auction", fails: 17, lastOkAt: null, firstFailureAt: after.f }, later)).toBe(true);
  });

  it("still starts the clock when a HEALTHY source begins failing", async () => {
    // The guard must not break the case it was built for.
    await env.DB.prepare("DELETE FROM source_state").run();
    const t0 = new Date("2026-08-02T09:00:00.000Z");
    const base = {
      source: "was_healthy",
      etag: null,
      lastModified: null,
      cursor: null,
      lastPolledAt: iso(t0),
      lastOkAt: iso(t0),
    };
    await putSourceState(env.DB, { ...base, consecutiveFailures: 0 }, t0);
    const t1 = new Date("2026-08-02T10:00:00.000Z");
    await putSourceState(env.DB, { ...base, consecutiveFailures: 1, lastOkAt: null }, t1);

    const f = (await env.DB.prepare(`SELECT first_failure_at AS f FROM source_state WHERE source = 'was_healthy'`)
      .first<{ f: string | null }>())!.f;
    expect(f).toBe(iso(t1));
  });
});

describe("a job that polls no source can still be failing", () => {
  // THE LIVE INSTANCE, 2026-08-02. `source_health` sat at
  // jobs.consecutive_failures = 7 for seven hours and appeared in no report.
  //
  // It has enabled = 1, so the disabled clause missed it. It has NO
  // source_state row, so COALESCE made its source count 0 and the source
  // clause missed it. And jobs.last_ok_at was non-null from before the
  // breakage, so the never-ran clause missed it. Three clauses, all blind to
  // the same row -- and the row was the health system itself.
  //
  // Cause was code ahead of schema: #84 merged at 22:40:30Z selecting
  // s.first_failure_at; migration 0048 landed 05:09Z the next morning. Every
  // hourly run between threw `no such column`. It self-healed, and the seven
  // hours were invisible because a throwing job writes a counter and no error
  // text anywhere.
  it("reports a sourceless job whose HANDLER is throwing", async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority, last_ok_at, consecutive_failures)
       VALUES ('watcher_job', '2026-08-02T06:00:00.000Z', 'hourly', 1, 50, '2026-08-01T22:23:01.000Z', 7)`,
    ).run();

    const rows = await healthReport(env as never, new Date("2026-08-02T05:23:00.000Z"));
    const row = rows.find((r) => r.name === "watcher_job");
    expect(row, "a job failing 7 times must appear in the report").toBeTruthy();
    expect(row!.jobFails).toBe(7);
    expect(row!.fails).toBe(0); // no source_state row: the SOURCE is not what failed
    expect(row!.hasSource).toBe(0);

    // Assert on THIS row's line, not on the whole report: the seeded fleet
    // has other rows that legitimately say "never succeeded", and a
    // whole-text assertion would be measuring them instead.
    const line = formatHealth(rows, new Date("2026-08-02T05:23:00.000Z"))
      .split("\n")
      .find((l) => l.startsWith("watcher_job:"))!;
    expect(line, "the failing job must have its own line").toBeTruthy();
    // Name which thing broke: an unanswering source and a throwing handler
    // need different responses, and one "N fails" hid the difference.
    expect(line).toContain("JOB fails (handler throwing)");
    // And read the job clock, since there is no source clock to read.
    expect(line).toContain("last ok 7h ago");
    expect(line).not.toContain("never succeeded");
  });
});

describe("total_failures counts failed POLLS, not state writes", () => {
  // WHY THIS EXISTS. consecutive_failures resets on the next success and
  // last_ok_at is overwritten, so a source failing two polls in three leaves
  // no trace at all -- a week of one-in-three landing is byte-identical in D1
  // to a perfect week. That is why "were the senate polls failing, or does
  // eFD index late" could not be answered retroactively: both readings imply
  // different fixes and the evidence was already gone.
  const put = (source: string, fails: number, okAt: string | null) =>
    putSourceState(env.DB as never, {
      source,
      etag: null,
      lastModified: null,
      cursor: null,
      lastPolledAt: "2026-08-02T12:00:00.000Z",
      lastOkAt: okAt,
      consecutiveFailures: fails,
    } as never);

  const total = async (source: string) =>
    (
      await env.DB.prepare(`SELECT total_failures AS n FROM source_state WHERE source = ?1`)
        .bind(source)
        .first<{ n: number }>()
    )!.n;

  it("counts one per failed poll across a streak and a recovery", async () => {
    await put("ctr_a", 1, null); // first poll, failed
    expect(await total("ctr_a")).toBe(1);
    await put("ctr_a", 2, null);
    await put("ctr_a", 3, null);
    expect(await total("ctr_a")).toBe(3);

    await put("ctr_a", 0, "2026-08-02T12:00:00.000Z"); // recovered
    expect(await total("ctr_a"), "a success must not decrement or reset it").toBe(3);

    await put("ctr_a", 1, "2026-08-02T12:00:00.000Z"); // fails again later
    expect(await total("ctr_a")).toBe(4);
  });

  it("does NOT multiply by how many times a handler saves state mid-poll", async () => {
    // bls.ts calls putSourceState up to seven times in one poll and halts.ts
    // five. Counting "+1 while failing" would make those sources report
    // several failures for one bad fetch, which is the exact wrong number
    // this column exists to provide.
    await put("ctr_b", 1, null); // the poll failed: one increment
    await put("ctr_b", 1, null); // same poll, handler saves a cursor
    await put("ctr_b", 1, null); // and again
    expect(await total("ctr_b")).toBe(1);
  });

  it("starts a pre-existing row at zero rather than inventing history", async () => {
    await env.DB.prepare(
      `INSERT INTO source_state (source, last_polled_at, consecutive_failures)
       VALUES ('ctr_legacy', '2026-08-01T00:00:00.000Z', 6)`,
    ).run();
    expect(await total("ctr_legacy"), "a back-fill would invent a history nobody recorded").toBe(0);
    await put("ctr_legacy", 7, null);
    expect(await total("ctr_legacy"), "and counting starts from the next real failure").toBe(1);
  });
});
