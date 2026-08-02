import { describe, expect, it } from "vitest";
import { nextDue } from "../src/cadence";

const at = (s: string) => new Date(s);

describe("nextDue", () => {
  it("every_2m_us_0600_2200: 2 min inside the ET window, 10 min outside", () => {
    // Wed 2026-07-22 10:00 EDT
    expect(nextDue("every_2m_us_0600_2200", at("2026-07-22T14:00:00Z")).toISOString()).toBe(
      "2026-07-22T14:02:00.000Z",
    );
    // Tue 23:00 EDT (off hours)
    expect(nextDue("every_2m_us_0600_2200", at("2026-07-22T03:00:00Z")).toISOString()).toBe(
      "2026-07-22T03:10:00.000Z",
    );
    // Saturday
    expect(nextDue("every_2m_us_0600_2200", at("2026-07-25T14:00:00Z")).toISOString()).toBe(
      "2026-07-25T14:10:00.000Z",
    );
  });

  it("every_5m_us_0600_2200: 5 min inside the ET window, 30 min outside", () => {
    expect(nextDue("every_5m_us_0600_2200", at("2026-07-22T14:00:00Z")).toISOString()).toBe(
      "2026-07-22T14:05:00.000Z",
    );
    expect(nextDue("every_5m_us_0600_2200", at("2026-07-22T03:00:00Z")).toISOString()).toBe(
      "2026-07-22T03:30:00.000Z",
    );
    expect(nextDue("every_5m_us_0600_2200", at("2026-07-25T14:00:00Z")).toISOString()).toBe(
      "2026-07-25T14:30:00.000Z",
    );
  });

  it("off-window cadence clamps to the window open — no blind first minutes", () => {
    // Wed 05:55 EDT: naive +10min would be 06:05; clamp to 06:00 EDT = 10:00Z.
    expect(nextDue("every_2m_us_0600_2200", at("2026-07-22T09:55:00Z")).toISOString()).toBe(
      "2026-07-22T10:00:00.000Z",
    );
    // Wed 05:45 EDT: naive +30min would be 06:15; clamp to 06:00 EDT.
    expect(nextDue("every_5m_us_0600_2200", at("2026-07-22T09:45:00Z")).toISOString()).toBe(
      "2026-07-22T10:00:00.000Z",
    );
  });

  it("every_1m_us_0400_2000: 1 min in-session, parked to next weekday 04:00 ET otherwise", () => {
    expect(nextDue("every_1m_us_0400_2000", at("2026-07-22T14:00:00Z")).toISOString()).toBe(
      "2026-07-22T14:01:00.000Z",
    );
    // Sat 2026-07-25 10:00 EDT -> Mon Jul 27 04:00 EDT = 08:00Z
    expect(nextDue("every_1m_us_0400_2000", at("2026-07-25T14:00:00Z")).toISOString()).toBe(
      "2026-07-27T08:00:00.000Z",
    );
    // Fri 20:00 EDT exactly (= Sat 00:00Z; window is [start, end)) -> parked to Mon 04:00 EDT.
    expect(nextDue("every_1m_us_0400_2000", at("2026-07-25T00:00:00Z")).toISOString()).toBe(
      "2026-07-27T08:00:00.000Z",
    );
  });

  it("fixed-interval profiles", () => {
    expect(nextDue("every_5m", at("2026-07-22T14:00:00Z")).toISOString()).toBe("2026-07-22T14:05:00.000Z");
    expect(nextDue("every_30m", at("2026-07-22T14:00:00Z")).toISOString()).toBe("2026-07-22T14:30:00.000Z");
    expect(nextDue("hourly", at("2026-07-22T14:00:00Z")).toISOString()).toBe("2026-07-22T15:00:00.000Z");
  });

  it("daily_1330_utc: today if still ahead, else tomorrow", () => {
    expect(nextDue("daily_1330_utc", at("2026-07-22T12:00:00Z")).toISOString()).toBe("2026-07-22T13:30:00.000Z");
    expect(nextDue("daily_1330_utc", at("2026-07-22T14:00:00Z")).toISOString()).toBe("2026-07-23T13:30:00.000Z");
  });

  it("unknown profiles park an hour out instead of hot-looping", () => {
    expect(nextDue("bogus_profile", at("2026-07-22T14:00:00Z")).toISOString()).toBe("2026-07-22T15:00:00.000Z");
  });
});

describe("same-cadence jobs must not stay phase-locked (p4-20)", () => {
  const IN_WINDOW = new Date("2026-07-22T14:00:00Z"); // Wed 10:00 ET, inside every window

  it("the three SEC jobs no longer reschedule to a byte-identical due_at", () => {
    // THE DEFECT, in its production instance. sec_form144, sec_schedule13 and
    // sec_form25 all carry every_5m_us_0600_2200 at priority 50 (migrations
    // 0012/0021/0035). Called with the tick's single shared `now` they landed
    // on the same due_at and stayed locked forever — which is why they sort
    // adjacently and arrive in one wave "by construction, not by luck", and
    // why the nested-pool connection count was 3x rather than 1x.
    const names = ["sec_form144", "sec_schedule13", "sec_form25"];
    const withKey = names.map((n) => nextDue("every_5m_us_0600_2200", IN_WINDOW, n).getTime());
    expect(new Set(withKey).size).toBe(3);

    // And the old behaviour, to show the test can tell the difference.
    const withoutKey = names.map(() => nextDue("every_5m_us_0600_2200", IN_WINDOW).getTime());
    expect(new Set(withoutKey).size).toBe(1);
  });

  it("holds the interval exactly once a job is on its phase", () => {
    // Phase, not jitter: an additive offset would slow every job permanently
    // and let them drift back together. Walk ten cycles and assert every gap
    // is exactly 5 minutes.
    let t = nextDue("every_5m", IN_WINDOW, "sec_form144");
    for (let i = 0; i < 10; i++) {
      const next = nextDue("every_5m", t, "sec_form144");
      expect(next.getTime() - t.getTime()).toBe(5 * 60_000);
      t = next;
    }
  });

  it("bounds the one-time transition at [interval/2, 1.5*interval)", () => {
    // Both ends matter. Too short and ~55 jobs double-poll on the deploy that
    // ships this, which is a thundering herd from the change meant to stop
    // one. Too long and a source silently stalls. Bounded once, exact after.
    for (const name of ["a", "bb", "sec_form25", "edgar_8k", "halts_nyse", "issuer_refresh", "press_sebi"]) {
      for (const [profile, mins] of [["every_5m", 5], ["every_30m", 30], ["hourly", 60]] as const) {
        const ms = mins * 60_000;
        const gap = nextDue(profile, IN_WINDOW, name).getTime() - IN_WINDOW.getTime();
        expect(gap).toBeGreaterThanOrEqual(ms / 2);
        expect(gap).toBeLessThan(ms * 1.5);
      }
    }
  });

  it("a phase is stable across calls, so a job holds its slot", () => {
    // Math.random() would have made this fail: the phase must survive a
    // redeploy and a different isolate, or the job wanders instead of holding.
    const a = nextDue("hourly", IN_WINDOW, "issuer_refresh").getTime();
    const b = nextDue("hourly", IN_WINDOW, "issuer_refresh").getTime();
    expect(a).toBe(b);
  });

  it("spreads a realistic fleet across the interval rather than clustering", () => {
    // 14 hourly press jobs, the shape of the global-wire batches.
    const names = Array.from({ length: 14 }, (_, i) => `press_source_${i}`);
    const due = names.map((n) => nextDue("hourly", IN_WINDOW, n).getTime());
    expect(new Set(due).size).toBeGreaterThanOrEqual(13); // near-total dispersion
    // No more than a third of them inside any single minute.
    const byMinute = new Map<number, number>();
    for (const d of due) {
      const m = Math.floor(d / 60_000);
      byMinute.set(m, (byMinute.get(m) ?? 0) + 1);
    }
    expect(Math.max(...byMinute.values())).toBeLessThanOrEqual(5);
  });

  it("leaves the wall-clock profiles aligned, because alignment is their point", () => {
    // daily_1330_utc and daily_2100_et are slots, not intervals. Phasing them
    // would move a deliberate time.
    expect(nextDue("daily_1330_utc", new Date("2026-07-22T12:00:00Z"), "job_a").toISOString()).toBe(
      "2026-07-22T13:30:00.000Z",
    );
    expect(nextDue("daily_1330_utc", new Date("2026-07-22T12:00:00Z"), "job_b").toISOString()).toBe(
      "2026-07-22T13:30:00.000Z",
    );
  });

  it("off-window clamping still lands every job on the window open", () => {
    // Stated rather than assumed: this change does NOT disperse the open-time
    // herd. Every off-window job still converges on 06:00 ET, because the
    // clamp exists so the first minutes of a trading day are never covered at
    // the slow rate. Named here so the next person sizing a tier knows the
    // convergence is still there.
    const offHours = new Date("2026-07-22T03:00:00Z"); // 23:00 ET Tue
    const a = nextDue("every_2m_us_0600_2200", offHours, "sec_form144").getTime();
    const b = nextDue("every_2m_us_0600_2200", offHours, "sec_form25").getTime();
    expect(a).toBe(b);
  });
});
