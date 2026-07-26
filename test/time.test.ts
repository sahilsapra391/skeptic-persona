import { describe, expect, it } from "vitest";
import { ET, IST, inWeekdayWindow, isWeekday, minutesOfDay, nextLocalTime, utcOffsetMinutes, zonedParts } from "../src/lib/time";

// US DST is rule-based law: begins second Sunday of March, ends first Sunday
// of November, at 02:00 local. For 2026 that is Mar 8 and Nov 1.

describe("utcOffsetMinutes", () => {
  it("handles the 2026 spring-forward boundary", () => {
    expect(utcOffsetMinutes(new Date("2026-03-08T06:59:00Z"), ET)).toBe(-300); // 01:59 EST
    expect(utcOffsetMinutes(new Date("2026-03-08T07:00:00Z"), ET)).toBe(-240); // 03:00 EDT
  });

  it("handles the 2026 fall-back boundary", () => {
    expect(utcOffsetMinutes(new Date("2026-11-01T05:59:00Z"), ET)).toBe(-240); // 01:59 EDT
    expect(utcOffsetMinutes(new Date("2026-11-01T06:00:00Z"), ET)).toBe(-300); // 01:00 EST
  });

  it("IST is fixed +330 year-round", () => {
    expect(utcOffsetMinutes(new Date("2026-01-15T12:00:00Z"), IST)).toBe(330);
    expect(utcOffsetMinutes(new Date("2026-07-15T12:00:00Z"), IST)).toBe(330);
  });
});

describe("zonedParts / weekday / minutes", () => {
  it("converts a known instant to ET wall clock", () => {
    // 2026-07-22 is a Wednesday; 14:30Z = 10:30 EDT.
    const p = zonedParts(new Date("2026-07-22T14:30:00Z"), ET);
    expect(p).toMatchObject({ year: 2026, month: 7, day: 22, hour: 10, minute: 30, weekday: 3 });
    expect(minutesOfDay(new Date("2026-07-22T14:30:00Z"), ET)).toBe(630);
  });

  it("weekday flips across the ET midnight, not UTC midnight", () => {
    // 2026-07-25 03:00Z is Friday 23:00 EDT.
    expect(isWeekday(new Date("2026-07-25T03:00:00Z"), ET)).toBe(true);
    // 2026-07-25 14:00Z is Saturday 10:00 EDT.
    expect(isWeekday(new Date("2026-07-25T14:00:00Z"), ET)).toBe(false);
  });
});

describe("inWeekdayWindow", () => {
  const win = (d: string) => inWeekdayWindow(new Date(d), ET, 6 * 60, 22 * 60);
  it("inside the window on a weekday", () => {
    expect(win("2026-07-22T14:00:00Z")).toBe(true); // Wed 10:00 EDT
  });
  it("outside hours and on weekends", () => {
    expect(win("2026-07-22T03:00:00Z")).toBe(false); // Tue 23:00 EDT
    expect(win("2026-07-25T14:00:00Z")).toBe(false); // Sat
  });
  it("window boundaries are [start, end)", () => {
    expect(inWeekdayWindow(new Date("2026-07-22T10:00:00Z"), ET, 6 * 60, 22 * 60)).toBe(true); // 06:00 EDT exact
    expect(inWeekdayWindow(new Date("2026-07-23T02:00:00Z"), ET, 6 * 60, 22 * 60)).toBe(false); // 22:00 EDT exact
  });
});

describe("nextLocalTime", () => {
  it("lands on the correct UTC instant across spring-forward", () => {
    // From Sat Mar 7 2026 12:00Z, next weekday 08:30 ET is Mon Mar 9 08:30 EDT = 12:30Z.
    const got = nextLocalTime(new Date("2026-03-07T12:00:00Z"), ET, 8, 30, true);
    expect(got.toISOString()).toBe("2026-03-09T12:30:00.000Z");
  });

  it("lands on the correct UTC instant across fall-back", () => {
    // From Sat Oct 31 2026 12:00Z, next weekday 08:30 ET is Mon Nov 2 08:30 EST = 13:30Z.
    const got = nextLocalTime(new Date("2026-10-31T12:00:00Z"), ET, 8, 30, true);
    expect(got.toISOString()).toBe("2026-11-02T13:30:00.000Z");
  });

  it("without weekdaysOnly returns the very next occurrence", () => {
    // Sat Mar 7 19:00 EST (= Mar 8 00:00Z): next 08:30 ET is Sunday Mar 8, 08:30 EDT = 12:30Z.
    const got = nextLocalTime(new Date("2026-03-08T00:00:00Z"), ET, 8, 30, false);
    expect(got.toISOString()).toBe("2026-03-08T12:30:00.000Z");
  });

  it("is strictly after `from`", () => {
    const from = new Date("2026-07-22T12:30:00Z"); // exactly 08:30 EDT
    const got = nextLocalTime(from, ET, 8, 30, false);
    expect(got.getTime()).toBeGreaterThan(from.getTime());
    expect(got.toISOString()).toBe("2026-07-23T12:30:00.000Z");
  });

  it("targets inside the early-morning DST window on transition days are exact", () => {
    // Spring-forward day, 04:00 EDT = 08:00Z (naive offset math lands hours off here).
    expect(nextLocalTime(new Date("2026-03-08T01:00:00Z"), ET, 4, 0, false).toISOString()).toBe(
      "2026-03-08T08:00:00.000Z",
    );
    // Fall-back day, 04:00 EST = 09:00Z.
    expect(nextLocalTime(new Date("2026-11-01T00:00:00Z"), ET, 4, 0, false).toISOString()).toBe(
      "2026-11-01T09:00:00.000Z",
    );
  });

  it("nonexistent spring-forward gap times resolve one hour later", () => {
    // 02:30 ET does not exist on 2026-03-08; convention: 03:30 EDT = 07:30Z.
    expect(nextLocalTime(new Date("2026-03-08T01:00:00Z"), ET, 2, 30, false).toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("does not skip a local date on the 23-hour spring-forward day", () => {
    // From Sat Mar 7 23:59 EST, the next 04:00 ET is on Sunday Mar 8 (EDT).
    expect(nextLocalTime(new Date("2026-03-08T04:59:00Z"), ET, 4, 0, false).toISOString()).toBe(
      "2026-03-08T08:00:00.000Z",
    );
  });
});
