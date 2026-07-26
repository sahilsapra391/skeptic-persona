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
