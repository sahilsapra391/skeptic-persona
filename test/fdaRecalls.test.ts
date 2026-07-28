import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FIXTURE from "./fixtures/fda-recalls.json?raw";
import {
  draftRecall,
  FDA_RECALLS,
  fdaDateToIso,
  parseRecalls,
  FDA_SOURCES,
  pollFdaEnforcement,
  scoreRecall,
  SOURCE,
  type FdaRecall,
} from "../src/ingesters/fdaRecalls";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixture captured 2026-07-27T22:49Z. THIS is the parse contract.
const NOW = new Date("2026-07-27T23:00:00Z");

describe("parseRecalls (live fixture)", () => {
  const parsed = parseRecalls(FIXTURE);

  it("parses the verified record exactly", () => {
    const r = parsed.find((x) => x.firm === "Chiesi USA, Inc.")!;
    expect(r).toMatchObject({
      classification: "Class II",
      status: "Ongoing",
      reason: "Lack of Assurance of Sterility",
      quantity: "44280 vials",
      distribution: "Nationwide within the United States",
      initiatedIso: "2026-07-06",
      reportedIso: "2026-07-22",
    });
    expect(r.product).toContain("CLEVIPREX");
  });

  it("computes the disclosure lag from the record's own two dates", () => {
    const r = parsed.find((x) => x.firm === "Chiesi USA, Inc.")!;
    // 2026-07-06 -> 2026-07-22
    expect(r.disclosureLagDays).toBe(16);
  });

  it("a record we cannot name or grade is dropped, not half-parsed", () => {
    const rows = { results: [{ recalling_firm: "", classification: "Class I", event_id: "1" }] };
    expect(parseRecalls(JSON.stringify(rows))).toEqual([]);
    const noClass = { results: [{ recalling_firm: "X", classification: "", event_id: "1" }] };
    expect(parseRecalls(JSON.stringify(noClass))).toEqual([]);
  });

  it("leaves the lag null when either date is missing", () => {
    const rows = {
      results: [{ recalling_firm: "X", classification: "Class II", event_id: "9", recall_initiation_date: "20260706" }],
    };
    expect(parseRecalls(JSON.stringify(rows))[0]?.disclosureLagDays).toBeNull();
  });
});

describe("fdaDateToIso", () => {
  it("parses YYYYMMDD and refuses impossible dates", () => {
    expect(fdaDateToIso("20260706")).toBe("2026-07-06");
    // Would roll forward to March 2 if we trusted Date alone.
    expect(fdaDateToIso("20260230")).toBeNull();
    expect(fdaDateToIso("2026-07-06")).toBeNull();
    expect(fdaDateToIso("")).toBeNull();
  });
});

describe("scoreRecall", () => {
  const base = parseRecalls(FIXTURE)[0]!;

  it("grades on FDA's OWN classification, never on our reading of the reason", () => {
    expect(scoreRecall({ ...base, classification: "Class I" })).toBe(SCORE_AUTO_ALERT);
    expect(scoreRecall({ ...base, classification: "Class II" })).toBe(SCORE_POSTABLE);
    expect(scoreRecall({ ...base, classification: "Class III" })).toBe(SCORE_LOG_ONLY);
    // A terrifying reason string does not upgrade a Class III.
    expect(scoreRecall({ ...base, classification: "Class III", reason: "Contamination, death reported" })).toBe(
      SCORE_LOG_ONLY,
    );
  });

  it("a record missing its reason or product is never postable", () => {
    expect(scoreRecall({ ...base, reason: "" })).toBe(SCORE_LOG_ONLY);
    expect(scoreRecall({ ...base, product: "" })).toBe(SCORE_LOG_ONLY);
  });
});

describe("draftRecall", () => {
  it("carries FDA's wording and no em-dash", () => {
    const r = parseRecalls(FIXTURE).find((x) => x.firm === "Chiesi USA, Inc.")!;
    const d = draftRecall(r, "drug");
    // The dataset is named now that food recalls share this archetype.
    expect(d).toContain("FDA Class II drug recall: Chiesi USA, Inc.");
    expect(d).toContain("Reason: Lack of Assurance of Sterility");
    expect(d).toContain("Initiated 2026-07-06");
    expect(d).not.toContain("—");
    expect(draftRecall(r, "food")).toContain("FDA Class II food recall:");
  });

  it("truncates a very long product description rather than blowing the budget", () => {
    const r = parseRecalls(FIXTURE)[0]!;
    const d = draftRecall({ ...r, product: "X".repeat(400) });
    expect(d).toContain("\u2026");
    expect(d.length).toBeLessThan(300);
  });
});

describe("PRODUCT_RECALL archetype", () => {
  const payload = {
    factLine: "FDA Class II recall: Chiesi USA, Inc. CLEVIPREX. Reason: Lack of Assurance of Sterility",
    firm: "Chiesi USA, Inc.",
    classification: "Class II",
    reason: "Lack of Assurance of Sterility",
    status: "Ongoing",
    initiatedIso: "2026-07-06",
    reportedIso: "2026-07-22",
    disclosureLagDays: 16,
    voluntaryIsFirmInitiated: true,
  };

  it("renders fact + attribution + a gated beat", () => {
    const r = renderPost(ARCHETYPES.PRODUCT_RECALL, payload, { seed: "r:1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per FDA");
    expect(r.text).not.toContain("—");
  });

  it("the slow-disclosure beat needs a genuinely long gap", () => {
    const quick = pickBeat(ARCHETYPES.PRODUCT_RECALL, payload, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(quick?.beat.id).not.toBe("recall.slowDisclosure");

    const slow = pickBeat(
      ARCHETYPES.PRODUCT_RECALL,
      { ...payload, disclosureLagDays: 45 },
      { recentSkeletons: [], recentBeats: [] },
      0,
    );
    expect(slow?.beat.id).toBe("recall.slowDisclosure");
    expect(slow?.text).toBe("45 days from the firm acting to the public knowing.");
  });

  it("the voluntary beat gates on FDA's parsed field, not on prose", () => {
    const mandated = pickBeat(
      ARCHETYPES.PRODUCT_RECALL,
      { ...payload, voluntaryIsFirmInitiated: false },
      { recentSkeletons: [], recentBeats: ["recall.lag", "recall.classIsFdas", "recall.stillOngoing"] },
      0,
    );
    expect(mandated?.beat.id).not.toBe("recall.voluntary");
  });
});

describe("pollFdaRecalls end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const API = "https://api.fda.gov";
  const PATH = FDA_RECALLS.replace(API, "");

  it("ingests, grades and records the lag as a fact", async () => {
    fetchMock.get(API).intercept({ path: PATH }).reply(200, FIXTURE);
    await pollFdaEnforcement(env, FDA_SOURCES[0]!, NOW, newTickBudget(30));

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(SOURCE).first<{ n: number }>();
    expect(rows?.n).toBeGreaterThan(0);

    const facts = await env.DB.prepare("SELECT metric, value FROM lookback_facts WHERE source = ?1").bind(SOURCE).all<{ metric: string; value: number }>();
    expect(facts.results.every((f) => f.metric === "recall_disclosure_lag_days")).toBe(true);
  });

  it("a 429 is a busy neighbour, not a broken source", async () => {
    // openFDA rate-limits per IP and Cloudflare egress IPs are SHARED, so a
    // burst from any other Worker can hit us. That must not mark the source
    // unhealthy and trip the failure alarms.
    fetchMock.get(API).intercept({ path: PATH }).reply(429, "Too Many Requests");
    await pollFdaEnforcement(env, FDA_SOURCES[0]!, NOW, newTickBudget(30));

    const state = await env.DB.prepare("SELECT consecutive_failures AS f FROM source_state WHERE source = ?1")
      .bind(SOURCE)
      .first<{ f: number }>();
    expect(state?.f).toBe(0);
  });
});
