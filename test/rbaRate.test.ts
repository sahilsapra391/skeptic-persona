import { describe, expect, it } from "vitest";
import RBA from "./fixtures/rba-f1.csv.fixture?raw";
import {
  detectChange,
  draftRate,
  latestEffective,
  parseRbaF1,
  rbaDateToIso,
  RATE_SOURCES,
  RBA_CASH_RATE_SERIES,
} from "../src/ingesters/rates";

// Live-verified 2026-07-28 against the RBA's own F1 table: Cash Rate Target
// 4.35%, last changed 06-May-2026 from 4.10%. The fixture is the tail of that
// file, trimmed to span the change and the newest (empty-valued) row.

const src = RATE_SOURCES.find((s) => s.id === "rate_rba")!;

describe("RBA F1 cash rate", () => {
  it("is registered as a rate source with an honest attribution", () => {
    expect(src).toBeTruthy();
    expect(src.country).toBe("Australia");
    expect(src.attribution).toMatch(/^per /);
    expect(src.url).toContain("rba.gov.au");
  });

  it("reads the series by its published id, not by column position", () => {
    // The file carries 17 columns; their order is the RBA's to change.
    const header = RBA.split("\n").find((l) => l.startsWith("Series ID,"))!;
    expect(header.split(",")).toContain(RBA_CASH_RATE_SERIES);

    // Move the target column and the parser must follow it.
    const cols = header.split(",");
    const idx = cols.indexOf(RBA_CASH_RATE_SERIES);
    const swapped = RBA.split("\n")
      .map((line) => {
        if (!/^(Series ID,|\d{1,2}-[A-Za-z]{3}-\d{4},)/.test(line)) return line;
        const c = line.split(",");
        [c[idx], c[idx + 1]] = [c[idx + 1] ?? "", c[idx] ?? ""];
        return c.join(",");
      })
      .join("\n");
    expect(parseRbaF1(swapped).at(-1)!.value).toBe(parseRbaF1(RBA).at(-1)!.value);
  });

  it("parses the tail and lands on the verified current rate", () => {
    const obs = parseRbaF1(RBA);
    expect(obs.length).toBeGreaterThan(50);
    const current = latestEffective(obs, new Date("2026-07-28T06:00:00Z"));
    expect(current).toEqual({ date: "2026-07-27", value: 4.35 });
  });

  it("produces NO observation for the empty newest cell", () => {
    // The newest row is published before the day's value is set. An empty
    // cell must not become 0, which would read as a cut to zero.
    expect(RBA.trim().split("\n").at(-1)).toMatch(/^28-Jul-2026,,/);
    const obs = parseRbaF1(RBA);
    expect(obs.some((o) => o.date === "2026-07-28")).toBe(false);
    expect(obs.some((o) => o.value === 0)).toBe(false);
  });

  it("finds the real change and states it from parsed values only", () => {
    const obs = parseRbaF1(RBA);
    const change = detectChange(obs, new Date("2026-05-06T06:00:00Z"));
    expect(change).toBeTruthy();
    expect(change!.current).toEqual({ date: "2026-05-06", value: 4.35 });
    expect(change!.prior.value).toBe(4.1);
    expect(change!.direction).toBe("raised");
    expect(change!.bps).toBe(25);

    const line = draftRate(src, change!);
    expect(line).toBe("Australia: Cash Rate Target raised to 4.35% from 4.1%, effective 2026-05-06");
  });

  it("calls a flat series no news", () => {
    // Weeks after the move, the same number reprints daily. Not a change.
    expect(detectChange(parseRbaF1(RBA), new Date("2026-07-27T06:00:00Z"))).toBeNull();
  });

  it("returns nothing rather than guessing when the shape is wrong", () => {
    expect(parseRbaF1("")).toEqual([]);
    expect(parseRbaF1("no series id row here\n01-Jan-2026,4.35")).toEqual([]);
    // Header present but the series absent: refuse rather than take column 1.
    const noSeries = RBA.replace(RBA_CASH_RATE_SERIES, "FIRMMOTHER");
    expect(parseRbaF1(noSeries)).toEqual([]);
  });

  it("rejects malformed dates instead of coercing them", () => {
    expect(rbaDateToIso("27-Jul-2026")).toBe("2026-07-27");
    expect(rbaDateToIso("6-May-2026")).toBe("2026-05-06");
    expect(rbaDateToIso("27-Zzz-2026")).toBeNull();
    expect(rbaDateToIso("2026-07-27")).toBeNull();
    expect(rbaDateToIso("")).toBeNull();
  });
});
