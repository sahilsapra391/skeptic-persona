import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FIXTURE from "./fixtures/noaa-storms.json?raw";
import {
  draftStorm,
  MAJOR_HURRICANE_KT,
  NHC_CURRENT_STORMS,
  parseStorms,
  pollNoaaStorms,
  scoreStorm,
  SOURCE,
  type Storm,
} from "../src/ingesters/noaaStorms";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixture captured 2026-07-28T04:58Z.
const NOW = new Date("2026-07-28T05:00:00Z");
const atlantic = (over: Partial<Storm> = {}): Storm => ({
  id: "al052026",
  name: "Test",
  classification: "HU",
  intensityKt: 80,
  pressureMb: 970,
  basin: "al",
  movementDir: 300,
  movementSpeedKt: 12,
  ...over,
});

describe("parseStorms (live fixture)", () => {
  const storms = parseStorms(FIXTURE);

  it("parses the live storms with NHC's own units", () => {
    expect(storms.length).toBe(2);
    const gen = storms.find((s) => s.name === "Genevieve")!;
    expect(gen).toMatchObject({ classification: "HU", intensityKt: 125, pressureMb: 939, basin: "ep" });
  });

  it("derives the basin from NHC's storm id", () => {
    // "ep" eastern Pacific, "al" Atlantic — the id prefix is the only place
    // the basin is stated.
    expect(storms.every((s) => s.basin === "ep")).toBe(true);
  });

  it("an empty list is normal out of season, not a parse failure", () => {
    expect(parseStorms(JSON.stringify({ activeStorms: [] }))).toEqual([]);
    expect(parseStorms(JSON.stringify({}))).toEqual([]);
  });

  it("drops entries with no id or name rather than half-parsing", () => {
    expect(parseStorms(JSON.stringify({ activeStorms: [{ id: "", name: "X" }] }))).toEqual([]);
  });
});

describe("scoreStorm — the Atlantic gate is the editorial call", () => {
  it("eastern Pacific storms are lake-only however severe", () => {
    // BOTH live storms at verification time were Pacific, including a 125 kt
    // hurricane. Gulf energy and insurer exposure sit in the Atlantic.
    for (const s of parseStorms(FIXTURE)) expect(scoreStorm(s)).toBe(SCORE_LOG_ONLY);
    expect(scoreStorm(atlantic({ basin: "ep", intensityKt: 140 }))).toBe(SCORE_LOG_ONLY);
  });

  it("Atlantic hurricanes post, and majors alert", () => {
    expect(scoreStorm(atlantic({ intensityKt: 80 }))).toBe(SCORE_POSTABLE);
    expect(scoreStorm(atlantic({ intensityKt: MAJOR_HURRICANE_KT }))).toBe(SCORE_AUTO_ALERT);
  });

  it("tropical storms and depressions stay in the lake", () => {
    expect(scoreStorm(atlantic({ classification: "TS" }))).toBe(SCORE_LOG_ONLY);
    expect(scoreStorm(atlantic({ classification: "TD" }))).toBe(SCORE_LOG_ONLY);
  });

  it("an unmeasured intensity is never postable", () => {
    expect(scoreStorm(atlantic({ intensityKt: null }))).toBe(SCORE_LOG_ONLY);
  });
});

describe("draftStorm", () => {
  it("states the advisory and never a forecast", () => {
    const d = draftStorm(atlantic({ name: "Genevieve", intensityKt: 125, pressureMb: 939 }));
    expect(d).toBe("Atlantic hurricane Genevieve: 125 kt sustained, 939 mb, per the National Hurricane Center");
    expect(d).not.toContain("—");
    // Where it goes next is not ours to say.
    expect(d.toLowerCase()).not.toMatch(/expect|forecast|will (hit|make|strengthen)|landfall|track/);
  });
});

describe("STORM archetype", () => {
  const payload = {
    factLine: "Atlantic hurricane Genevieve: 125 kt sustained, 939 mb, per the National Hurricane Center",
    name: "Genevieve",
    classification: "HU",
    intensityKt: 125,
    pressureMb: 939,
    basin: "al",
  };

  it("renders fact + attribution and survives the publish guard", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const r = renderPost(ARCHETYPES.STORM, payload, { seed: "st:1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per the National Hurricane Center");
    expect(checkRegister(r.text, "STORM")).toEqual([]);
  });

  it("the major-hurricane beat needs the measured intensity", () => {
    const weak = pickBeat(ARCHETYPES.STORM, { ...payload, intensityKt: 70 }, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(weak?.beat.id).not.toBe("storm.major");
    const major = pickBeat(ARCHETYPES.STORM, payload, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(major?.beat.id).toBe("storm.major");
  });
});

describe("pollNoaaStorms end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const NHC = "https://www.nhc.noaa.gov";
  const PATH = NHC_CURRENT_STORMS.replace(NHC, "");

  it("captures Pacific storms to the lake and queues nothing", async () => {
    fetchMock.get(NHC).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollNoaaStorms(env, NOW, newTickBudget(20));

    const rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1").bind(SOURCE).all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results.every((r) => r.status === "logged")).toBe(true);
  });

  it("re-poll with an unchanged advisory inserts nothing new", async () => {
    fetchMock.get(NHC).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollNoaaStorms(env, NOW, newTickBudget(20));
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(SOURCE).first<{ n: number }>();
    // The dedup key carries intensity, so a restated advisory is a duplicate
    // while a strengthening storm is genuinely new.
    expect(n?.n).toBe(2);
  });
});
