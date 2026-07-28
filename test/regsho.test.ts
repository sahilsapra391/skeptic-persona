import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FIXTURE from "./fixtures/regsho-threshold.psv.fixture?raw";
import {
  diffThreshold,
  draftThreshold,
  parseThreshold,
  pollRegSho,
  regShoUrl,
  SOURCE,
} from "../src/ingesters/regsho";
import { newTickBudget } from "../src/lib/budget";
import { getSourceState, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { renderPost } from "../src/templates/render";

// Live fixture captured 2026-07-28T04:18Z (the 2026-07-27 list).
const NOW = new Date("2026-07-28T13:30:00Z"); // reads the 07-27 file

describe("regShoUrl", () => {
  it("builds the dated filename Nasdaq actually publishes", () => {
    expect(regShoUrl(new Date("2026-07-27T00:00:00Z"))).toBe(
      "https://www.nasdaqtrader.com/dynamic/symdir/regsho/nasdaqth20260727.txt",
    );
    expect(regShoUrl(new Date("2026-01-05T00:00:00Z"))).toContain("nasdaqth20260105.txt");
  });
});

describe("parseThreshold (live fixture)", () => {
  const rows = parseThreshold(FIXTURE);

  it("parses the pipe-delimited rows with Nasdaq's own category letters", () => {
    expect(rows.length).toBeGreaterThan(3);
    const advb = rows.find((r) => r.symbol === "ADVB")!;
    expect(advb.name).toContain("ADVANCED BIOMED");
    expect(["G", "S"]).toContain(advb.marketCategory);
  });

  it("keeps only rows actually flagged Y", () => {
    const notFlagged = "Symbol|Security Name|Market Category|Reg SHO Threshold Flag|Rule 3210|Filler\nXXXX|Test Co|S|N|N|";
    expect(parseThreshold(notFlagged)).toEqual([]);
  });

  it("ignores the header and any trailing record-count line", () => {
    const withCount = `${FIXTURE}\n0000010`;
    expect(parseThreshold(withCount).length).toBe(rows.length);
    expect(rows.every((r) => !/^\d/.test(r.symbol))).toBe(true);
  });
});

describe("diffThreshold — the product is the diff", () => {
  const rows = parseThreshold(FIXTURE);

  it("reports who joined and who left", () => {
    const prev = rows.slice(1).map((r) => r.symbol).concat("GONE");
    const d = diffThreshold(prev, rows);
    expect(d.entered.map((e) => e.symbol)).toEqual([rows[0]!.symbol]);
    expect(d.exited).toContain("GONE");
    expect(d.total).toBe(rows.length);
  });

  it("an unchanged list produces no news", () => {
    const d = diffThreshold(rows.map((r) => r.symbol), rows);
    expect(d.entered).toEqual([]);
    expect(d.exited).toEqual([]);
  });
});

describe("draftThreshold", () => {
  it("states the symbol, the name and the list date, nothing inferred", () => {
    const d = draftThreshold({ symbol: "ADVB", name: "ADVANCED BIOMED INC COM NEW", marketCategory: "S" }, "2026-07-27");
    expect(d).toBe("ADVB (ADVANCED BIOMED INC COM NEW) joined the Nasdaq Reg SHO threshold list, 2026-07-27");
    expect(d).not.toContain("—");
    // Never a claim about WHY a security is failing to deliver.
    expect(d.toLowerCase()).not.toMatch(/naked|manipulat|short seller/);
  });
});

describe("SETTLEMENT_FAILURE archetype", () => {
  it("renders fact + attribution and survives the publish guard", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const r = renderPost(
      ARCHETYPES.SETTLEMENT_FAILURE,
      {
        factLine: "ADVB joined the Nasdaq Reg SHO threshold list, 2026-07-27",
        symbol: "ADVB",
        name: "ADVANCED BIOMED INC COM NEW",
        listDate: "2026-07-27",
        listSize: 30,
      },
      { seed: "rs:1" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per Nasdaq");
    expect(checkRegister(r.text, "SETTLEMENT_FAILURE")).toEqual([]);
  });
});

describe("pollRegSho end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const NQ = "https://www.nasdaqtrader.com";
  const PATH = regShoUrl(new Date("2026-07-27T00:00:00Z")).replace(NQ, "");

  it("the FIRST run posts nothing: every symbol looks new without a prior list", async () => {
    fetchMock.get(NQ).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollRegSho(env, NOW, newTickBudget(20));

    const rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1").bind(SOURCE).all<{ status: string; score: number }>();
    expect(rows.results.length).toBeGreaterThan(0);
    // Claiming 30 securities "joined" when we simply have no prior list
    // would be fabrication by omission of context.
    expect(rows.results.every((r) => r.status === "logged" && r.score === SCORE_LOG_ONLY)).toBe(true);

    const state = await getSourceState(env.DB, SOURCE);
    expect(JSON.parse(state.cursor ?? "[]").length).toBe(parseThreshold(FIXTURE).length);

    // SECOND run, same test: storage is isolated per test in this pool, so
    // the baseline cursor only exists inside this block. A genuinely new
    // entrant is now postable because we HAVE a prior list to diff against.
    const withNew = `${FIXTURE.trimEnd()}\nZZZZ|BRAND NEW CO COM|S|Y|N|`;
    fetchMock.get(NQ).intercept({ path: PATH }).reply(200, withNew);
    await pollRegSho(env, NOW, newTickBudget(20));

    const zzzz = await env.DB.prepare(
      "SELECT status, score FROM items WHERE source = ?1 AND json_extract(payload,'$.symbol') = 'ZZZZ'",
    )
      .bind(SOURCE)
      .first<{ status: string; score: number }>();
    expect(zzzz?.score).toBe(SCORE_POSTABLE);
    // 'queued', not 'new': the drain ran in the same poll and handed it to
    // the approval queue, which is the whole point.
    expect(zzzz?.status).toBe("queued");
  });

  it("a weekend 404 is not a failure", async () => {
    fetchMock.get(NQ).intercept({ path: PATH }).reply(404, "Not Found");
    await pollRegSho(env, NOW, newTickBudget(20));
    const st = await getSourceState(env.DB, SOURCE);
    expect(st.consecutiveFailures).toBe(0);
  });
});
