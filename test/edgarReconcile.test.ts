import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import IDX from "./fixtures/edgar-form-index.idx.fixture?raw";
import {
  countByForm,
  COVERAGE_ALARM,
  indexUrlFor,
  pollEdgarReconcile,
  SOURCE,
  TRACKED,
} from "../src/ingesters/edgarReconcile";
import { newTickBudget } from "../src/lib/budget";
import { insertItem, SCORE_LOG_ONLY } from "../src/lib/db";

// Live fixture captured 2026-07-28T04:14Z from the 2026-07-27 index.
const NOW = new Date("2026-07-28T13:30:00Z"); // audits 2026-07-27

describe("indexUrlFor", () => {
  it("builds the quarter-partitioned path the SEC actually uses", () => {
    expect(indexUrlFor(new Date("2026-07-27T00:00:00Z"))).toBe(
      "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260727.idx",
    );
    // Quarter boundaries are where a naive path breaks.
    expect(indexUrlFor(new Date("2026-01-05T00:00:00Z"))).toContain("/2026/QTR1/form.20260105.idx");
    expect(indexUrlFor(new Date("2026-12-31T00:00:00Z"))).toContain("/2026/QTR4/form.20261231.idx");
  });
});

describe("countByForm", () => {
  const counts = countByForm(IDX);

  it("parses the FIXED-WIDTH layout, not whitespace-delimited", () => {
    // Company names contain spaces; a whitespace split mis-parses every row.
    expect(counts.size).toBeGreaterThan(3);
    expect([...counts.keys()].some((k) => k.includes("  "))).toBe(false);
  });

  it("counts real form types from the live index", () => {
    // The fixture is the head of the 2026-07-27 index, so it carries the
    // alphabetically-early forms.
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(50);
    for (const [form, n] of counts) {
      expect(form.length).toBeGreaterThan(0);
      expect(n).toBeGreaterThan(0);
    }
  });

  it("returns empty for a body with no separator rather than guessing", () => {
    expect(countByForm("garbage").size).toBe(0);
    expect(countByForm("").size).toBe(0);
  });
});

describe("TRACKED", () => {
  it("uses the EDGAR form strings verbatim, including the SCHEDULE spelling", () => {
    const forms = TRACKED.map((t) => t.formPrefix);
    // The trap this whole job exists to catch.
    expect(forms).toContain("SCHEDULE 13D");
    expect(forms).toContain("SCHEDULE 13G");
    expect(forms).not.toContain("SC 13D");
  });
});

describe("pollEdgarReconcile end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const SEC = "https://www.sec.gov";
  const PATH = indexUrlFor(new Date("2026-07-27T00:00:00Z")).replace(SEC, "");

  it("computes coverage against our lake and stores it as a lake-only audit", async () => {
    // Seed one 8-K on the audited ET day so coverage is non-zero.
    await insertItem(env.DB, {
      source: "edgar_8k",
      externalId: "RECON-1",
      category: "filing",
      eventAt: "2026-07-27T18:00:00.000Z",
      sourceUrl: "https://www.sec.gov/x",
      payload: {},
      score: SCORE_LOG_ONLY,
      status: "logged",
    });

    fetchMock.get(SEC).intercept({ path: PATH }).reply(200, IDX);
    await pollEdgarReconcile(env, NOW, newTickBudget(20));

    const row = await env.DB.prepare("SELECT payload, score, status FROM items WHERE source = ?1").bind(SOURCE).first<{
      payload: string;
      score: number;
      status: string;
    }>();
    expect(row).toBeTruthy();
    // Our own bookkeeping is never news.
    expect(row!.score).toBe(SCORE_LOG_ONLY);
    expect(row!.status).toBe("logged");

    const p = JSON.parse(row!.payload) as { date: string; rows: Array<{ label: string; secCount: number; ourCount: number }> };
    expect(p.date).toBe("2026-07-27");
    expect(p.rows.length).toBe(TRACKED.length);
    const eightK = p.rows.find((r) => r.label === "8-K")!;
    expect(eightK.ourCount).toBe(1);
  });

  it("a weekend 404 is not a failure", async () => {
    fetchMock.get(SEC).intercept({ path: PATH }).reply(404, "Not Found");
    await pollEdgarReconcile(env, NOW, newTickBudget(20));

    const st = await env.DB.prepare("SELECT consecutive_failures AS f, last_ok_at FROM source_state WHERE source = ?1")
      .bind(SOURCE)
      .first<{ f: number; last_ok_at: string | null }>();
    // No index exists on non-trading days; treating that as an outage would
    // alarm every weekend.
    expect(st?.f).toBe(0);
    expect(st?.last_ok_at).toBeTruthy();
  });

  it("a real failure is counted and its reason persisted", async () => {
    fetchMock.get(SEC).intercept({ path: PATH }).reply(500, "boom");
    await pollEdgarReconcile(env, NOW, newTickBudget(20));
    const st = await env.DB.prepare("SELECT consecutive_failures AS f, last_error FROM source_state WHERE source = ?1")
      .bind(SOURCE)
      .first<{ f: number; last_error: string | null }>();
    expect(st?.f).toBeGreaterThan(0);
    expect(st?.last_error).toContain("500");
  });

  it("the alarm threshold is a share, not a count", () => {
    // A 20-filing day at 40% coverage should alarm; a 5-filing day should not
    // (small-n noise), which is why the check requires secCount >= 20.
    expect(COVERAGE_ALARM).toBeGreaterThan(0);
    expect(COVERAGE_ALARM).toBeLessThan(1);
  });
});
