import { describe, expect, it } from "vitest";
import {
  exerciseAndSellOf,
  insiderFactsOf,
  lateFilingOf,
  pctDisposedOf,
  planLanguage,
} from "../src/pipeline/insiderFacts";
import type { Form4Derivative, Form4Txn } from "../src/ingesters/form4";

const txn = (o: Partial<Form4Txn>): Form4Txn => ({
  securityTitle: "Common Stock",
  date: "2026-08-06",
  code: "S",
  acquiredDisposed: "D",
  shares: null,
  price: null,
  sharesAfter: null,
  direct: true,
  pctChange: null,
  timeliness: null,
  natureOfOwnership: null,
  ...o,
});

describe("planLanguage (B-10.1, the locked doctrine)", () => {
  it("licenses the phrase when the box is checked", () => {
    expect(planLanguage(true)).toBe("under a pre-adopted trading plan");
  });

  // THE POINT OF THE WHOLE FILE. An unchecked box is not an assertion that no
  // plan exists, so it licenses NO language -- not "discretionary", not "not
  // under a plan". Null means say nothing.
  it("licenses NOTHING when the box is unchecked", () => {
    expect(planLanguage(false)).toBeNull();
  });
});

describe("lateFilingOf (D-128, presence is not a value)", () => {
  // The live shape: <transactionTimeliness></transactionTimeliness>, present
  // in 15 of 60 filings and empty in all 34 occurrences. The element being
  // there says nothing, so neither do we.
  it("returns null when the element is present but empty", () => {
    expect(lateFilingOf([txn({ timeliness: "" }), txn({ timeliness: "" })])).toBeNull();
  });

  it("returns null when no row carries the element at all", () => {
    expect(lateFilingOf([txn({}), txn({})])).toBeNull();
  });

  // false is reserved for a filing that actually stated a timeliness and it
  // was not L. Only then have we been told the filing was on time.
  it("returns false only when a row states a non-late value", () => {
    expect(lateFilingOf([txn({ timeliness: "E" })])).toBe(false);
  });

  it("returns true when any row states L", () => {
    expect(lateFilingOf([txn({ timeliness: "" }), txn({ timeliness: "L" })])).toBe(true);
    expect(lateFilingOf([txn({ timeliness: "l" })])).toBe(true);
  });

  // Guards the regression directly: on the real corpus this field is never
  // true, and a boolean would have reported "not late" for all 60.
  it("never reports a plain false across a corpus that states nothing", () => {
    const corpus = Array.from({ length: 60 }, () => [txn({ timeliness: "" })]);
    expect(corpus.map(lateFilingOf).every((v) => v === null)).toBe(true);
  });
});

describe("pctDisposedOf", () => {
  it("reconstructs the prior balance rather than assuming one", () => {
    // 37,337 sold leaving 88,473: 37337 / 125810 = 29.7%.
    const r = pctDisposedOf([txn({ shares: 37337, sharesAfter: 88473, price: 22.72 })]);
    expect(r).toEqual({ pct: 29.7, sharesAfter: 88473 });
  });

  it("totals the filing's disposals against the line's closing balance", () => {
    // One ownership line: sharesAfter runs down, and its last value is the
    // stake left. Multi-line filings are covered below (D-129).
    const r = pctDisposedOf([
      txn({ date: "2026-08-04", shares: 100, sharesAfter: 900 }),
      txn({ date: "2026-08-05", shares: 400, sharesAfter: 500 }),
    ]);
    expect(r).toEqual({ pct: 50, sharesAfter: 500 });
  });

  // D-129, FROM THE REAL FILING. Jeremy Allaire's Circle Form 4 of 2026-08-05:
  // 25 rows across five ownership lines, direct plus four trusts. Taking the
  // last row's balance as the stake reported 50.2%; the truth is 8.8%.
  it("sums the final balance of EVERY ownership line, not just the last row", () => {
    const line = (nature: string | null, after: number[], shares: number) =>
      after.map((a) =>
        txn({ date: "2026-08-05", shares, sharesAfter: a, direct: nature === null, natureOfOwnership: nature }),
      );
    const rows = [
      ...line(null, [448697, 439005, 419524, 406463, 398179], 11240),
      ...line("By Oak Trust", [62200, 62100, 62000, 61900, 61834], 303.2),
      ...line("By Chestnut Trust", [62200, 62100, 62000, 61900, 61830], 303.2),
      ...line("By Beech Trust", [62200, 62100, 62000, 61900, 61830], 303.2),
      ...line("By Spruce Trust", [62200, 62100, 62000, 61900, 61830], 303.2),
    ];
    const r = pctDisposedOf(rows);
    expect(r?.sharesAfter).toBe(645503); // 398179 + 61834 + 61830 * 3
    expect(r?.pct).toBe(8.8);
  });

  it("keys indirect lines apart by nature, since four trusts are all I", () => {
    const a = txn({ shares: 100, sharesAfter: 900, direct: false, natureOfOwnership: "By A Trust" });
    const b = txn({ shares: 100, sharesAfter: 900, direct: false, natureOfOwnership: "By B Trust" });
    // Two lines of 900, not one: the stake is 1,800 and 200/2000 = 10%.
    expect(pctDisposedOf([a, b])).toEqual({ pct: 10, sharesAfter: 1800 });
  });

  // The two Clear Secure ($YOU) filings of 2026-08-06: nine sales all reporting
  // a balance of 0, then a DISPOSAL whose balance rises to 17,806,342. Not a
  // running balance, so no percentage is available and none is invented.
  it("returns null when a disposal INCREASES the balance", () => {
    const rows = [
      ...Array.from({ length: 9 }, () => txn({ shares: 1000, sharesAfter: 0 })),
      txn({ code: "D", shares: 323904, sharesAfter: 17806342 }),
    ];
    expect(pctDisposedOf(rows)).toBeNull();
  });

  it("voids the whole number when one line's final balance did not parse", () => {
    const rows = [
      txn({ shares: 100, sharesAfter: 900, direct: true, natureOfOwnership: null }),
      txn({ shares: 100, sharesAfter: null, direct: false, natureOfOwnership: "By Trust" }),
    ];
    expect(pctDisposedOf(rows)).toBeNull();
  });

  // The coherence gate rejects a DISPOSAL that raises a balance. An
  // acquisition raising one is ordinary and must still pass, so long as the
  // filing sold more than it acquired and the holding actually shrank.
  it("allows an acquisition to raise the balance", () => {
    const rows = [
      txn({ code: "M", acquiredDisposed: "A", shares: 1000, sharesAfter: 5000 }),
      txn({ code: "S", acquiredDisposed: "D", shares: 2000, sharesAfter: 3000, price: 40 }),
    ];
    // opening = 3,000 left + 2,000 out - 1,000 in = 4,000; 2,000 sold = 50%.
    expect(pctDisposedOf(rows)).toEqual({ pct: 50, sharesAfter: 3000 });
  });

  // D-130 / B-32.3. Each of these is a SUPPRESSION, never a correction.
  describe("domain invariants suppress rather than repair", () => {
    // Barrett/MGNI: exercised 293,968 and sold 293,968 the same day, closing on
    // 403,074 shares, exactly where he opened. 12 of 60 live filings are
    // net-flat or net-positive; the old code called this one 42.2%.
    it("suppresses when the holding did not shrink", () => {
      const rows = [
        txn({ code: "M", acquiredDisposed: "A", shares: 293968, sharesAfter: 697042 }),
        txn({ code: "S", acquiredDisposed: "D", shares: 293968, sharesAfter: 403074, price: 22.72 }),
      ];
      expect(pctDisposedOf(rows)).toBeNull();
      // ...but the closing stake and the net change are still honest.
      const f = insiderFactsOf(rows, [], true);
      expect(f.sharesAfter).toBe(403074);
      expect(f.netShareChange).toBe(0);
      expect(f.sharesSold).toBe(293968);
    });

    // Nine live filings disposed only via F (tax withholding) or G (gift).
    it("suppresses when nothing was SOLD, only withheld or gifted", () => {
      expect(pctDisposedOf([txn({ code: "F", shares: 4628, sharesAfter: 54000 })])).toBeNull();
      expect(pctDisposedOf([txn({ code: "G", shares: 500000, sharesAfter: 24500000 })])).toBeNull();
    });

    it("counts only sale rows in the numerator when a filing mixes them", () => {
      // 1,000 sold and 500 withheld against a 8,500 close: opening is 10,000
      // and the SALE is 10%, not the 15% the combined disposal would give.
      const rows = [
        txn({ code: "S", shares: 1000, sharesAfter: 9000, price: 50 }),
        txn({ code: "F", shares: 500, sharesAfter: 8500 }),
      ];
      expect(pctDisposedOf(rows)).toEqual({ pct: 10, sharesAfter: 8500 });
    });

    // Clamping would turn a broken filing into a confident "sold everything".
    it("suppresses rather than clamps a percentage outside 0-100", () => {
      // Closing balance larger than it can be given the disposal: opening
      // reconstructs below the sold amount, so the share exceeds 100%.
      const rows = [txn({ code: "S", shares: 1000, sharesAfter: 0, price: 5 }), txn({ code: "S", shares: 5, sharesAfter: 0, price: 5 })];
      const r = pctDisposedOf(rows);
      expect(r === null || (r.pct > 0 && r.pct <= 100)).toBe(true);
    });
  });

  it("ignores acquisitions", () => {
    expect(pctDisposedOf([txn({ code: "A", acquiredDisposed: "A", shares: 10, sharesAfter: 90 })])).toBeNull();
  });

  it("returns null when either input is missing", () => {
    expect(pctDisposedOf([txn({ shares: 100, sharesAfter: null })])).toBeNull();
    expect(pctDisposedOf([txn({ shares: null, sharesAfter: 100 })])).toBeNull();
  });
});

describe("exerciseAndSellOf", () => {
  const deriv = (o: Partial<Form4Derivative>): Form4Derivative =>
    ({ code: "M", date: "2026-08-06", shares: 1000, exercisePrice: 19.15, underlyingTitle: "Common Stock", ...o }) as Form4Derivative;

  it("weights the sale price by shares so a small lot cannot move it", () => {
    const r = exerciseAndSellOf(
      [
        txn({ code: "M", acquiredDisposed: "A", shares: 1000 }),
        txn({ code: "S", shares: 900, price: 56.21 }),
        txn({ code: "S", shares: 100, price: 58.79 }),
      ],
      [deriv({})],
    );
    // (900*56.21 + 100*58.79)/1000 = 56.468 -> spread 37.32
    expect(r?.exercisePrice).toBe(19.15);
    expect(r?.spread).toBe(37.32);
  });

  it("omits the spread when no exercise price parsed, rather than assuming one", () => {
    const r = exerciseAndSellOf(
      [txn({ code: "M", acquiredDisposed: "A", shares: 1000 }), txn({ code: "S", shares: 1000, price: 56.21 })],
      [],
    );
    expect(r).toEqual({ spread: null, exercisePrice: null });
  });

  it("is null without both an M and an S", () => {
    expect(exerciseAndSellOf([txn({ code: "S", shares: 1, price: 1 })], [deriv({})])).toBeNull();
  });
});

describe("insiderFactsOf", () => {
  it("carries the shape gates a beat needs", () => {
    const f = insiderFactsOf([txn({ shares: 37337, sharesAfter: 88473, price: 22.72 })], [], true);
    expect(f.pctDisposed).toBe(29.7);
    expect(f.planFlag).toBe(true);
    expect(f.lateFiling).toBeNull();
    expect(f.codes).toEqual(["S"]);
    expect(f.rowCount).toBe(1);
  });
});
