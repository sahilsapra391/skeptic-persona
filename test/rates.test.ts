import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import BOC from "./fixtures/rate-boc.json?raw";
import RIKSBANK from "./fixtures/rate-riksbank.json?raw";
import BCB from "./fixtures/rate-bcb.json?raw";
import SARB from "./fixtures/rate-sarb.json?raw";
import BOE from "./fixtures/rate-boe.csv.fixture?raw";
import ECB from "./fixtures/rate-ecb.csv.fixture?raw";
import SNB from "./fixtures/rate-snb.xml.fixture?raw";
import NORGES from "./fixtures/rate-norges.csv.fixture?raw";
import {
  boeDate,
  boeDateToIso,
  brDateToIso,
  detectChange,
  draftRate,
  latestEffective,
  makeRateHandler,
  RATE_SOURCES,
  type RateObservation,
} from "../src/ingesters/rates";
import { newTickBudget } from "../src/lib/budget";
import { urlFor } from "../src/ingesters/rates";
import { getSourceState } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixtures captured 2026-07-27T22:30Z. These ARE the parse contract.
const NOW = new Date("2026-07-27T23:00:00Z");
const byId = (id: string) => RATE_SOURCES.find((s) => s.id === id)!;

describe("parsers (live fixtures)", () => {
  it("Bank of Canada Valet: nested series cell, newest-first", () => {
    const obs = byId("rate_boc").parse(BOC);
    expect(obs.length).toBe(3);
    expect(obs[0]).toEqual({ date: "2026-07-24", value: 2.25 });
  });

  it("Riksbank SWEA: flat array, ISO dates, native numbers", () => {
    const obs = byId("rate_riksbank").parse(RIKSBANK);
    expect(obs[0]).toEqual({ date: "2026-05-04", value: 1.75 });
    expect(obs.every((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date))).toBe(true);
  });

  it("Brazil SGS: DD/MM/YYYY and string values", () => {
    const obs = byId("rate_bcb").parse(BCB);
    expect(obs[0]).toEqual({ date: "2026-08-03", value: 14.25 });
  });

  it("SARB: picks the policy rate out of a mixed indicator list", () => {
    const obs = byId("rate_sarb").parse(SARB);
    expect(obs.length).toBeGreaterThan(0);
    expect(obs[0]?.value).toBe(7);
    // The feed carries Sabor, repo, prime etc.; only the policy rate is ours.
    expect(JSON.parse(SARB).some((r: { Name: string }) => r.Name === "Sabor")).toBe(true);
  });

  it("Bank of England IADB: 'DD Mon YYYY' CSV", () => {
    const obs = byId("rate_boe").parse(BOE);
    expect(obs.length).toBeGreaterThan(100);
    expect(obs[0]).toEqual({ date: "2026-01-02", value: 3.75 });
    expect(obs.at(-1)).toEqual({ date: "2026-07-24", value: 3.75 });
  });

  it("ECB SDMX-CSV: columns located by NAME, never by position", () => {
    const obs = byId("rate_ecb").parse(ECB);
    expect(obs.at(-1)).toEqual({ date: "2026-07-27", value: 2.4 });
    // SDMX emits ~30 columns; a positional parser would break on any
    // upstream column addition.
    expect(ECB.split("\n")[0]!.split(",").length).toBeGreaterThan(20);
  });

  it("SNB: picks the POLICY rate by code, not the special liquidity rate", () => {
    // The feed's cb:rateName values are codes (SNBLZ, LSFF, R10, SARH...),
    // not prose. Filtering on a human label matched nothing and the source
    // failed in production. SNBLZ is the Leitzins; LSFF sits right next to
    // it at a different level and is a different instrument.
    const obs = byId("rate_snb").parse(SNB);
    expect(obs.length).toBeGreaterThan(0);
    expect(SNB).toContain("LSFF"); // the decoy is present in the fixture
    // Every observation must come from the policy-rate item only.
    const policyValues = new Set(obs.map((o) => o.value));
    expect(policyValues.has(0.25)).toBe(false); // that is LSFF's level
  });

  it("Norges Bank: SEMICOLON-delimited SDMX CSV, columns by name", () => {
    const obs = byId("rate_norges").parse(NORGES);
    expect(obs.length).toBeGreaterThan(100);
    expect(obs.at(-1)).toEqual({ date: "2026-07-24", value: 4.25 });
    // A comma split would silently yield one column and zero observations.
    expect(NORGES.split("\n")[0]!.includes(";")).toBe(true);
    expect(NORGES.split("\n")[0]!.split(",").length).toBe(1);
  });

  it("every source parses its own fixture to at least one observation", () => {
    for (const [id, body] of [
      ["rate_boc", BOC],
      ["rate_riksbank", RIKSBANK],
      ["rate_bcb", BCB],
      ["rate_sarb", SARB],
      ["rate_boe", BOE],
      ["rate_ecb", ECB],
      ["rate_snb", SNB],
      ["rate_norges", NORGES],
    ] as const) {
      expect(byId(id).parse(body).length, id).toBeGreaterThan(0);
    }
  });
});

describe("boeDateToIso / boeDate", () => {
  it("round-trips the Bank of England's two date formats", () => {
    expect(boeDateToIso("02 Jan 2026")).toBe("2026-01-02");
    expect(boeDateToIso("24 Jul 2026")).toBe("2026-07-24");
    expect(boeDateToIso("2026-07-24")).toBeNull();
    expect(boeDateToIso("32 Xxx 2026")).toBeNull();
    // The request format differs from the response format.
    expect(boeDate(new Date("2026-07-27T00:00:00Z"))).toBe("27/Jul/2026");
  });

  it("builds a rolling one-year window ending YESTERDAY", () => {
    // Yesterday is the safer bound (never asks for a value that may not
    // exist yet), NOT a fix for IADB's overnight 500s — direct test showed
    // both same-day and prior-day windows return 200.
    const url = urlFor(byId("rate_boe"), new Date("2026-07-28T03:50:00Z"));
    expect(url).toContain("Dateto=27/Jul/2026");
    expect(url).toContain("Datefrom=27/Jul/2025");
    expect(url).not.toContain("Dateto=28/Jul/2026");
  });
});

describe("brDateToIso", () => {
  it("converts Brazil's format and refuses anything else", () => {
    expect(brDateToIso("03/08/2026")).toBe("2026-08-03");
    expect(brDateToIso("2026-08-03")).toBeNull();
    expect(brDateToIso("")).toBeNull();
  });
});

describe("latestEffective — the forward-dating trap", () => {
  it("never returns an observation dated in the future", () => {
    // VERIFIED LIVE: Brazil publishes the Selic target for the days it will be
    // in effect, so on 27 July the newest rows were dated 3-5 August. Naively
    // taking the newest row publishes a future rate as today's.
    const obs = byId("rate_bcb").parse(BCB);
    expect(obs.some((o) => o.date > "2026-07-27")).toBe(true); // the trap exists
    expect(latestEffective(obs, NOW)).toBeNull(); // ...and we refuse all of it
  });

  it("returns the newest observation at or before today", () => {
    const obs: RateObservation[] = [
      { date: "2026-07-20", value: 1 },
      { date: "2026-07-26", value: 2 },
      { date: "2026-08-10", value: 3 },
    ];
    expect(latestEffective(obs, NOW)).toEqual({ date: "2026-07-26", value: 2 });
  });
});

describe("detectChange", () => {
  const obs = (rows: Array<[string, number]>): RateObservation[] => rows.map(([date, value]) => ({ date, value }));

  it("reports a move at the current observation with bps and direction", () => {
    const c = detectChange(obs([["2026-07-20", 2.5], ["2026-07-26", 2.25]]), NOW);
    expect(c).toMatchObject({ bps: 25, direction: "lowered" });
    expect(c?.prior.value).toBe(2.5);
  });

  it("a flat series is not news", () => {
    expect(detectChange(obs([["2026-07-20", 2.25], ["2026-07-26", 2.25]]), NOW)).toBeNull();
  });

  it("a move that already happened and has since been flat is old news", () => {
    // Cut on the 21st, flat since: the current observation is not a change.
    const c = detectChange(obs([["2026-07-20", 2.5], ["2026-07-21", 2.25], ["2026-07-26", 2.25]]), NOW);
    expect(c).toBeNull();
  });

  it("a single observation can never be a change", () => {
    expect(detectChange(obs([["2026-07-26", 2.25]]), NOW)).toBeNull();
  });

  it("computes bps from the parsed levels, not from a rounded string", () => {
    const c = detectChange(obs([["2026-07-20", 14.25], ["2026-07-26", 13.75]]), NOW);
    expect(c?.bps).toBe(50);
    expect(c?.direction).toBe("lowered");
  });
});

describe("draftRate + RATE_DECISION archetype", () => {
  it("states both levels and the effective date, with no em-dash", () => {
    const src = byId("rate_boc");
    const d = draftRate(src, {
      current: { date: "2026-07-26", value: 2.25 },
      prior: { date: "2026-06-04", value: 2.5 },
      bps: 25,
      direction: "lowered",
    });
    expect(d).toBe("Canada: Target for the overnight rate lowered to 2.25% from 2.5%, effective 2026-07-26");
    expect(d).not.toContain("—");
  });

  it("renders fact + attribution + a gated beat", () => {
    const r = renderPost(
      ARCHETYPES.RATE_DECISION,
      {
        factLine: "Canada: Target for the overnight rate lowered to 2.25% from 2.5%, effective 2026-07-26",
        country: "Canada",
        label: "Target for the overnight rate",
        value: 2.25,
        priorValue: 2.5,
        priorDate: "2026-06-04",
        observedDate: "2026-07-26",
        changeBps: 25,
        direction: "lowered",
      },
      { seed: "rate:1" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per the central bank");
    expect(r.text).not.toContain("—");
  });

  it("the jumbo beat needs a genuinely large move", () => {
    const base = { factLine: "x", changeBps: 25, priorValue: 2.5, priorDate: "2026-06-04", observedDate: "2026-07-26" };
    expect(pickBeat(ARCHETYPES.RATE_DECISION, base, { recentSkeletons: [], recentBeats: [] }, 0)?.beat.id).not.toBe("rate.jumbo");
    expect(
      pickBeat(ARCHETYPES.RATE_DECISION, { ...base, changeBps: 50 }, { recentSkeletons: [], recentBeats: [] }, 0)?.beat.id,
    ).toBe("rate.jumbo");
  });

  it("no beat can render without its parsed field", () => {
    for (const beat of ARCHETYPES.RATE_DECISION.beats) {
      const picked = pickBeat(ARCHETYPES.RATE_DECISION, { factLine: "x" }, { recentSkeletons: [], recentBeats: [] }, 0);
      expect(picked?.beat.id).not.toBe(beat.id);
    }
  });
});

describe("poll end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("the FIRST sighting of a series establishes a baseline and posts nothing", async () => {
    const src = byId("rate_riksbank");
    const u = new URL(urlFor(src, NOW));
    fetchMock.get(u.origin).intercept({ path: u.pathname + u.search }).reply(200, RIKSBANK);

    await makeRateHandler(src)(env, NOW, newTickBudget(20));

    const rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1").bind(src.id).all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(1);
    // We cannot claim a change we did not witness.
    expect(rows.results[0]?.status).toBe("logged");
    const state = await getSourceState(env.DB, src.id);
    expect(state.cursor).toBeTruthy();
    expect(state.consecutiveFailures).toBe(0);
  });

  it("a failing endpoint counts a failure and posts nothing", async () => {
    const src = byId("rate_sarb");
    const u = new URL(urlFor(src, NOW));
    fetchMock.get(u.origin).intercept({ path: u.pathname + u.search }).reply(503, "down");

    await makeRateHandler(src)(env, NOW, newTickBudget(20));
    const state = await getSourceState(env.DB, src.id);
    expect(state.consecutiveFailures).toBe(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(src.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
