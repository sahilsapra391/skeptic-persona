import { describe, expect, it } from "vitest";
import { containsRawDate, displayDate, displayDateRange, parseDateParts } from "../src/lib/dates";

const NOW = new Date("2026-08-08T12:00:00.000Z");

describe("A3: one date convention, and the parse that must not use Date.parse", () => {
  it("renders the owner's convention", () => {
    expect(displayDate("2026-08-05", NOW)).toBe("August 5");
    expect(displayDate("2025-08-05", NOW)).toBe("August 5, 2025");
  });

  it("reads all three conventions the feeds actually file", () => {
    expect(displayDate("2026-08-05", NOW)).toBe("August 5"); // EDGAR
    expect(displayDate("08/07/2026", NOW)).toBe("August 7"); // Form 144
    expect(displayDate("2026-08-05T14:00:00.000Z", NOW)).toBe("August 5"); // our payloads
    expect(displayDate("8/5/2026", NOW)).toBe("August 5"); // unpadded
  });

  it("a slash date is parsed by COMPONENT, so no zone can shift the day", () => {
    // `Date.parse("08/07/2026")` is LOCAL midnight; reading it back with
    // getUTCDate is off by one on any host east of Greenwich. CI and workerd
    // are both UTC, so the bug passes green everywhere it is tested.
    expect(parseDateParts("08/07/2026")).toEqual({ year: 2026, month: 8, day: 7 });
    expect(parseDateParts("2026-08-07")).toEqual({ year: 2026, month: 8, day: 7 });
    // and the ISO datetime's time half is ignored rather than converted
    expect(parseDateParts("2026-08-07T23:59:59.000Z")).toEqual({ year: 2026, month: 8, day: 7 });
    expect(parseDateParts("2026-08-07T00:00:00.000Z")).toEqual({ year: 2026, month: 8, day: 7 });
  });

  it("the year is dropped ONLY when it is the current one", () => {
    // "August 5" for a 2025 filing would silently claim this year.
    expect(displayDate("2025-12-31", NOW)).toBe("December 31, 2025");
    expect(displayDate("2027-01-01", NOW)).toBe("January 1, 2027");
    expect(displayDate("2026-01-01", NOW)).toBe("January 1");
  });

  it("an unreadable date is OMITTED, never approximated", () => {
    for (const bad of ["", "   ", "not a date", "2026-13-01", "02/30/2026", "20260805", null, undefined, 42]) {
      expect(displayDate(bad, NOW)).toBeNull();
    }
  });

  it("ranges do not repeat the month, and card #1244's shape is fixed", () => {
    // shipped: "over 2026-08-05–2026-08-06"
    expect(displayDateRange("2026-08-05", "2026-08-06", NOW)).toBe("August 5–6");
    expect(displayDateRange("2026-07-30", "2026-08-02", NOW)).toBe("July 30–August 2");
    expect(displayDateRange("2026-08-05", "2026-08-05", NOW)).toBe("August 5");
    expect(displayDateRange("2025-12-30", "2026-01-02", NOW)).toBe("December 30, 2025–January 2, 2026");
  });

  it("the guard recognises every raw shape that shipped", () => {
    expect(containsRawDate("sold on 2026-08-06")).toBe(true);
    expect(containsRawDate("on or after 08/07/2026")).toBe(true);
    expect(containsRawDate("Filed 8/5/2026")).toBe(true);
    expect(containsRawDate("week ending 2026-08-04")).toBe(true);
    expect(containsRawDate("sold on August 6")).toBe(false);
    expect(containsRawDate("August 5–6")).toBe(false);
    // and it must not fire on a dollar figure or a share count
    expect(containsRawDate("$28.72M across 499,246 shares")).toBe(false);
  });
});
