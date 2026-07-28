import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import PERSONA_DOC from "../docs/persona.md?raw";
import { ARCHETYPES, PENDING_BEATS } from "../src/templates/archetypes";
import { evaluateGate, gateFields } from "../src/templates/gate";
import { fillSlots, pickBeat, renderPost, seedHash, THREADS_TEXT_LIMIT } from "../src/templates/render";
import type { Archetype, ArchetypeId, Beat } from "../src/templates/types";
import { GATE_OPS } from "../src/templates/types";
import { loadRotation, renderForQueue } from "../src/templates";
import { insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { enqueueForApproval } from "../src/pipeline/enqueue";

const ALL: Archetype[] = Object.values(ARCHETYPES);
const allBeats = (): Array<{ archetype: Archetype; beat: Beat }> =>
  ALL.flatMap((a) => a.beats.map((b) => ({ archetype: a, beat: b })));

// ---------------------------------------------------------------------------
// DOCTRINE. These tests encode docs/persona.md; they are the reason the engine
// exists. A failure here means the account is about to violate its own rules.

describe("doctrine: gates", () => {
  it("EVERY beat carries a gate (no ungated beats on a wire account)", () => {
    for (const { archetype, beat } of allBeats()) {
      expect(beat.when, `${archetype.id}/${beat.id} has no gate`).toBeDefined();
      expect(GATE_OPS).toContain(beat.when.op);
    }
  });

  it("NO beat renders against an empty payload (absence satisfies nothing)", () => {
    for (const { archetype, beat } of allBeats()) {
      expect(evaluateGate(beat.when, {}), `${archetype.id}/${beat.id} rendered with no data`).toBe(false);
    }
  });

  it("negative operators still fail on a missing field", () => {
    // The subtlest fail-open in gate design: neq on absent data must be false.
    expect(evaluateGate({ op: "neq", field: "missing", value: "x" }, {})).toBe(false);
    expect(evaluateGate({ op: "neq", field: "present", value: "x" }, { present: "y" })).toBe(true);
  });

  it("numeric operators never coerce strings", () => {
    expect(evaluateGate({ op: "gte", field: "lag", value: 30 }, { lag: "45" })).toBe(false);
    expect(evaluateGate({ op: "gte", field: "lag", value: 30 }, { lag: 45 })).toBe(true);
  });

  it("a parsed zero counts as present (it is a real value)", () => {
    expect(evaluateGate({ op: "has", field: "n" }, { n: 0 })).toBe(true);
    expect(evaluateGate({ op: "has", field: "n" }, { n: null })).toBe(false);
    expect(evaluateGate({ op: "has", field: "n" }, { n: "" })).toBe(false);
  });

  it("empty arrays are absence for gating", () => {
    expect(evaluateGate({ op: "has", field: "items" }, { items: [] })).toBe(false);
    expect(evaluateGate({ op: "includes", field: "codes", value: "4.02" }, { codes: [] })).toBe(false);
  });
});

describe("doctrine: no fabrication", () => {
  it("slot interpolation fails CLOSED (never blank, never zero-filled)", () => {
    expect(fillSlots("Disclosed {lagDays} days later.", {})).toBeNull();
    expect(fillSlots("Disclosed {lagDays} days later.", { lagDays: null })).toBeNull();
    expect(fillSlots("Disclosed {lagDays} days later.", { lagDays: 30 })).toBe("Disclosed 30 days later.");
    // A parsed 0 is a real value and must render.
    expect(fillSlots("{n} signatures, not one.", { n: 0 })).toBe("0 signatures, not one.");
  });

  it("no beat contains a number that isn't a slot or an allowlisted literal", () => {
    for (const { archetype, beat } of allBeats()) {
      const withoutSlots = beat.text.replace(/\{[a-zA-Z0-9_.]+\}/g, "");
      const withoutLiterals = (beat.literals ?? []).reduce((acc, lit) => acc.split(lit).join(""), withoutSlots);
      const strayNumbers = withoutLiterals.match(/\d+(\.\d+)?/g) ?? [];
      expect(strayNumbers, `${archetype.id}/${beat.id}: unsourced number in "${beat.text}"`).toEqual([]);
    }
  });

  it("every beat's gate reads a field its claim depends on", () => {
    for (const { archetype, beat } of allBeats()) {
      expect(gateFields(beat.when).length, `${archetype.id}/${beat.id}`).toBeGreaterThan(0);
    }
  });
});

describe("doctrine: register", () => {
  it("no em-dashes in any beat or rendered fact line (persona.md section 6)", () => {
    for (const { archetype, beat } of allBeats()) {
      expect(beat.text, `${archetype.id}/${beat.id}`).not.toContain("—");
    }
  });

  it("no hashtags, no engagement-bait questions, no advice verbs", () => {
    const advice = /\b(buy|sell|short|avoid|watch this|target|bullish|bearish)\b/i;
    for (const { archetype, beat } of allBeats()) {
      expect(beat.text, `${archetype.id}/${beat.id}`).not.toContain("#");
      expect(beat.text.endsWith("?"), `${archetype.id}/${beat.id} is a question`).toBe(false);
      expect(advice.test(beat.text), `${archetype.id}/${beat.id} uses advice language`).toBe(false);
    }
  });

  it("every archetype declares mandatory attribution and renders it on the fact", () => {
    for (const a of ALL) {
      expect(a.attribution, a.id).toMatch(/^per /);
    }
  });
});

describe("doctrine: structural law (fact first, beat last, never blended)", () => {
  it("the beat is always the final line, separated from the fact block", () => {
    const r = renderPost(
      ARCHETYPES.CONGRESS_PTR,
      { factLine: "Senator sold $1,001 - $15,000 of notes", lagDays: 30, amountBand: "$1,001 - $15,000" },
      { seed: "x" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.text.split("\n");
    expect(lines[0]).toContain("per Senate eFD"); // attribution on the fact
    expect(r.text).toContain("\n\n"); // blank line separates beat
    expect(lines.at(-1)).not.toContain("per Senate eFD"); // beat is its own line
  });

  it("the fact block is never sacrificed for a beat (beat drops if over budget)", () => {
    const huge = "x".repeat(THREADS_TEXT_LIMIT - 20);
    const r = renderPost(ARCHETYPES.CONGRESS_PTR, { factLine: huge, lagDays: 40 }, { seed: "s" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text.length).toBeLessThanOrEqual(THREADS_TEXT_LIMIT);
    expect(r.beatId).toBeNull();
  });

  it("a verbose skeleton falls back to a shorter one instead of failing the render", () => {
    const manyItems = Array.from({ length: 9 }, (_, i) => ({
      code: "8.01",
      title: `Other Events with a deliberately long official title number ${i}`,
    }));
    const r = renderPost(
      ARCHETYPES.FILING_8K,
      { company: "VERBOSE CORP", formType: "8-K", items: manyItems, itemCodes: ["8.01"] },
      { seed: "FILING_8K:9001" },
    );
    expect(r.ok, "should fall back to the lead skeleton, not fail").toBe(true);
    if (!r.ok) return;
    expect(r.text.length).toBeLessThanOrEqual(THREADS_TEXT_LIMIT);
  });

  it("in a MULTI-LINE fact block, attribution is on the head line, not the last item", () => {
    // Force the multi-line skeleton by marking the single-line one as recent.
    const r = renderPost(
      ARCHETYPES.FILING_8K,
      {
        company: "ACME CORP",
        formType: "8-K",
        items: [
          { code: "4.02", title: "Non-Reliance on Previously Issued Financial Statements" },
          { code: "7.01", title: "Regulation FD Disclosure" },
        ],
        itemCodes: ["4.02", "7.01"],
      },
      { seed: "attr:1", rotation: { recentSkeletons: ["8k.lead"], recentBeats: [] } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skeletonId).toBe("8k.items");
    const factLines = r.text.split("\n\n")[0]!.split("\n");
    expect(factLines[0]).toContain("per SEC"); // the claim carries it
    expect(factLines.at(-1)).not.toContain("per SEC"); // an item title does not
  });

  it("guards suppress every beat (never a beat on an amendment)", () => {
    const picked = pickBeat(
      ARCHETYPES.FILING_8K,
      { formType: "8-K/A", itemCodes: ["4.02"], company: "ACME" },
      { recentSkeletons: [], recentBeats: [] },
      1,
    );
    expect(picked).toBeNull();
  });
});

describe("doctrine: disabled-until-built beats", () => {
  it("pending beats are declared but unreachable from any archetype library", () => {
    const liveIds = new Set(allBeats().map(({ beat }) => beat.id));
    for (const p of PENDING_BEATS) {
      expect(liveIds.has(p.id), `${p.id} leaked into a live library`).toBe(false);
      expect(p.requires.length).toBeGreaterThan(0);
    }
  });

  it("the casino signature never appears in normal rotation", () => {
    const casino = PENDING_BEATS.find((p) => p.id === "tape.casino");
    expect(casino).toBeDefined();
    // It requires tape data that does not exist in the pipeline yet.
    expect(casino?.requires).toContain("tape_join");
  });
});

describe("doctrine: persona doc parity", () => {
  it("every live beat's text appears verbatim in docs/persona.md", () => {
    for (const { archetype, beat } of allBeats()) {
      // Compare with slots normalized to the doc's own placeholder style.
      const docForm = beat.text
        .replace(/\{lagDays\}/g, "{lag}")
        .replace(/\{memberCount\}/g, "{n}")
        .replace(/\{tradeDate\}/g, "{d1}")
        .replace(/\{filedDate\}/g, "{d2}")
        .replace(/\{superlative\}/g, "")
        .replace(/\{haltCountToday\}/g, "{n}")
        .replace(/\{pctOfOutstanding\}/g, "{n}")
        .replace(/\{securitiesClass\}/g, "{class}")
        .replace(/\{sameItemOccurrence\}/g, "{n}")
        .replace(/\{changeBps\}/g, "{n}")
        .replace(/\{priorValue\}/g, "{x}")
        .replace(/\{priorDate\}/g, "{date}")
        .replace(/\{observedDate\}/g, "{date}")
        .replace(/\{indirectPct\}/g, "{n}")
        .replace(/\{allocationPercentage\}/g, "{n}")
        .replace(/\{initiatedIso\}/g, "{d1}")
        .replace(/\{reportedIso\}/g, "{d2}")
        .replace(/\{disclosureLagDays\}/g, "{n}")
        .replace(/\{signingDate\}/g, "{d1}")
        .replace(/\{publicationDate\}/g, "{d2}")
        .replace(/\{signingLagDays\}/g, "{n}")
        .replace(/\{openInterest\}/g, "{n}")
        .replace(/\{dateOfEvent\}/g, "{date}")
        .replace(/\{topPercent\}/g, "{n}");
      const found = PERSONA_DOC.includes(beat.text) || PERSONA_DOC.includes(docForm);
      expect(found, `${archetype.id}/${beat.id} not found in persona.md: "${beat.text}"`).toBe(true);
    }
  });

  it("every pending beat is documented as disabled in the doc", () => {
    for (const p of PENDING_BEATS) {
      expect(PERSONA_DOC.includes(p.text), `${p.id} missing from persona.md`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ROTATION

describe("doctrine: beats must be reachable (no dead library entries)", () => {
  it("every live beat's gate fields are producible by some ingester payload", () => {
    // A beat that can never fire is a lie in the library. Payload shapes here
    // mirror what the ingesters actually store (see the rewiring in PR-8).
    const producible: Record<string, string[]> = {
      FILING_8K: ["itemCodes", "company", "formType", "items", "sameItemOccurrence", "priorSameItemThisYear", "lookbackCoverageDays"],
      FILING_FORM4: ["primaryCode", "lagDays", "stakePrinted", "factLine", "who", "actionLine", "isAmendment"],
      INSIDER_NOTICE: [
        "aggregateMarketValue",
        "broker",
        "acquisitionIsExercise",
        "pctOfOutstanding",
        "factLine",
        "sellerName",
        "issuerName",
        "relationshipLabel",
        "unitsSold",
        "securitiesClass",
      ],
      INSIDER_CLUSTER: ["memberCount", "allCodeP", "factLine", "symbol", "roster"],
      CONGRESS_PTR: ["lagDays", "amountBand", "tradeDate", "filedDate", "singleTxn", "bandWidthUsd", "factLine", "who", "tradeLine"],
      MACRO_PRINT: ["momSigned", "coreSigned", "yoyPct", "partialParse", "superlative", "factLine", "releaseName", "refMonth", "momText"],
      FED_PRESS: ["title", "category"],
      HALT: ["reasonCode", "symbol", "name", "reasonText", "haltTimeEtShort", "haltCountToday"],
      RATE_DECISION: ["changeBps", "priorValue", "priorDate", "observedDate", "factLine", "country", "label", "value", "direction"],
      OWNERSHIP_STAKE: ["isSchedule13D", "dateOfEvent", "topPercent", "isAmendment", "factLine", "topPersonName", "issuerName"],
      POSITIONING: ["reportDate", "changeLevNet", "openInterest", "factLine", "contract", "levNet"],
      POLICY_ACTION: ["signingDate", "publicationDate", "number", "documentNumber", "signingLagDays", "factLine", "title", "kind"],
      PRODUCT_RECALL: [
        "initiatedIso",
        "reportedIso",
        "classification",
        "voluntaryIsFirmInitiated",
        "status",
        "disclosureLagDays",
        "factLine",
        "firm",
        "reason",
      ],
      TREASURY_AUCTION: ["indirectPct", "allocationPercentage", "bidToCoverRatio", "factLine", "securityTerm", "securityType", "highYield"],
    };
    for (const a of ALL) {
      for (const beat of a.beats) {
        for (const f of gateFields(beat.when)) {
          expect(producible[a.id], `${a.id}/${beat.id} gates on "${f}" which no ingester produces`).toContain(f);
        }
      }
    }
  });

  it("retired beats are declared pending with a capability, not silently dropped", () => {
    const pendingIds = new Set(PENDING_BEATS.map((p) => p.id));
    // The statement-diff family and the paper-PTR beat were removed from live
    // libraries because nothing can satisfy their gates yet.
    for (const id of ["fed.editIsNews", "fed.verbatim", "ptr.paper"]) {
      expect(pendingIds.has(id), `${id} vanished instead of being marked pending`).toBe(true);
    }
  });
});

describe("doctrine: beats never outrun the fact block", () => {
  it("a sell-only Form 4 cannot draw a purchase beat", () => {
    const sellOnly = {
      factLine: "Form 4: DOE JANE (CEO) sold 600,000 ACME at ~$12.00 ($7.2M) on 2026-07-02",
      primaryCode: "S",
      stakePrinted: false,
    };
    const picked = pickBeat(ARCHETYPES.FILING_FORM4, sellOnly, { recentSkeletons: [], recentBeats: [] }, 1);
    expect(picked?.beat.id).not.toBe("form4.codeP");
    expect(picked?.beat.id).not.toBe("form4.decision");
    expect(picked?.beat.id).not.toBe("form4.ownNumber");
  });

  it("'Buys only' requires a COMPUTED absence, never an assumed one", () => {
    const withSells = { memberCount: 3, allCodeP: false };
    const picked = pickBeat(ARCHETYPES.INSIDER_CLUSTER, withSells, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(picked?.beat.id).not.toBe("cluster.buysOnly");
  });

  it("core-above-headline compares SIGNED values, not magnitudes", () => {
    // Headline +0.5, core -0.6: magnitude comparison would publish a lie.
    const picked = pickBeat(
      ARCHETYPES.MACRO_PRINT,
      { factLine: "x", momSigned: 0.5, coreSigned: -0.6 },
      { recentSkeletons: [], recentBeats: [] },
      0,
    );
    expect(picked?.beat.id).not.toBe("macro.coreAbove");
  });

  it("the widest-ratio band (the minimum reportable one) is NOT an escalation", () => {
    // "$1,001 - $15,000" has the highest ratio in the Senate band table but is
    // the most routine disclosure there is.
    const routine = { factLine: "x", lagDays: 4, amountBand: "$1,001 - $15,000", bandWidthUsd: 13_999 };
    const picked = pickBeat(ARCHETYPES.CONGRESS_PTR, routine, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(picked?.beat.id).not.toBe("ptr.bandWork");
    const wide = { ...routine, amountBand: "$1,000,001 - $5,000,000", bandWidthUsd: 4_000_000 };
    const pickedWide = pickBeat(ARCHETYPES.CONGRESS_PTR, wide, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(pickedWide?.beat.id).toBe("ptr.bandWork");
  });

  it("multi-transaction PTRs never claim a single trade/public date pair", () => {
    const multi = { factLine: "x", tradeDate: "01/05/2026", filedDate: "07/24/2026", singleTxn: false, lagDays: 4 };
    const picked = pickBeat(ARCHETYPES.CONGRESS_PTR, multi, { recentSkeletons: [], recentBeats: ["ptr.disclosedLater", "ptr.lagProduct"] }, 0);
    expect(picked?.beat.id).not.toBe("ptr.dates");
  });
});

describe("doctrine: the pattern is the story", () => {
  it("the Nth-halt beat needs a real count, never renders on a first halt", () => {
    const first = { symbol: "X", reasonText: "Volatility Trading Pause", reasonCode: "LUDP", haltTimeEtShort: "14:06", haltCountToday: 1 };
    const picked = pickBeat(ARCHETYPES.HALT, first, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(picked?.beat.id).not.toBe("halt.nthToday");

    const fourth = { ...first, haltCountToday: 4 };
    const escalated = pickBeat(ARCHETYPES.HALT, fourth, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(escalated?.beat.id).toBe("halt.nthToday");
    expect(escalated?.text).toBe("Halt number 4 for this symbol today.");
  });
});

describe("doctrine: rendered output survives the publish-time guard", () => {
  // THE TEST THAT WAS MISSING. checkRegister runs on every post in
  // src/poster.ts, engine-rendered included — but nothing asserted that our
  // OWN templates pass it. Form 144's fact line said "filed notice to sell",
  // and \bsell\b is a banned advice token, so every draft was blocked at the
  // last gate and its queue row permanently rejected. Fully parsed, fully
  // sourced, and unpublishable.
  const REPRESENTATIVE: Record<string, Record<string, unknown>> = {
    FILING_8K: {
      company: "ACME CORP",
      formType: "8-K",
      items: [{ code: "4.02", title: "Non-Reliance on Previously Issued Financial Statements" }],
      itemCodes: ["4.02"],
    },
    FILING_FORM4: {
      factLine: "Form 4: Jane Doe (CEO) bought 50,000 DOCS at ~$12.34 ($617K) on 2026-07-24",
      who: "Jane Doe (CEO)",
      actionLine: "bought 50,000 DOCS at ~$12.34 ($617K) on 2026-07-24",
      primaryCode: "P",
      lagDays: 3,
      stakePrinted: true,
    },
    INSIDER_NOTICE: {
      factLine: "Bender Investment Company (Member of 10% Owner) filed notice of a proposed sale of 100,000 shares, $5.5M of Cactus Inc on or after 07/27/2026",
      sellerName: "Bender Investment Company",
      issuerName: "Cactus Inc",
      relationshipLabel: "Member of 10% Owner",
      unitsSold: 100000,
      aggregateMarketValue: 5_500_000,
      broker: "Merrill Lynch",
      securitiesClass: "Common",
      pctOfOutstanding: 4.2,
    },
    INSIDER_CLUSTER: {
      factLine: "Insider cluster: 3 insiders bought DOCS in the past week. A (Director) $200K, B (Director) $200K, C (Director) $200K. Combined $600K",
      memberCount: 3,
      symbol: "DOCS",
      roster: "A (Director) $200K, B (Director) $200K, C (Director) $200K",
      allCodeP: true,
    },
    CONGRESS_PTR: {
      factLine: "Senate PTR: Moreno, Bernardo. Sale (Full) $1,001 - $15,000, BAC (06/24/2026). Filed 07/24/2026",
      who: "Moreno, Bernardo",
      tradeLine: "Sale (Full) $1,001 - $15,000, BAC (06/24/2026)",
      filedDate: "07/24/2026",
      tradeDate: "06/24/2026",
      singleTxn: true,
      amountBand: "$1,001 - $15,000",
      lagDays: 30,
    },
    MACRO_PRINT: {
      factLine: "BLS: Consumer Price Index, June 2026: CPI -0.4% m/m, prior +0.5%",
      releaseName: "Consumer Price Index",
      refMonth: "June 2026",
      momText: "CPI -0.4% m/m",
      momSigned: -0.4,
      coreSigned: 0.1,
      yoyPct: 3.5,
    },
    FED_PRESS: { title: "Agencies issue joint statement", category: "Banking and Consumer Regulatory Policy" },
    OWNERSHIP_STAKE: {
      factLine: "Schedule 13D: Haggai Alon reports 201,485 shares, 18.5% of SMX",
      topPersonName: "Haggai Alon",
      issuerName: "SMX",
      topPercent: 18.5,
      dateOfEvent: "07/23/2026",
      isSchedule13D: true,
      isAmendment: false,
    },
    POSITIONING: {
      factLine: "CFTC positioning: leveraged funds net short 361,875 E-MINI S&P 500 contracts, week ending 2026-07-21",
      contract: "E-MINI S&P 500",
      levNet: -361875,
      reportDate: "2026-07-21",
      openInterest: 1969636,
      changeLevNet: -1406,
    },
    POLICY_ACTION: {
      factLine: "Executive Order 14415: Securing America's Defense Supply Chains, signed 2026-07-20",
      title: "Securing America's Defense Supply Chains",
      kind: "Executive Order",
      number: "14415",
      documentNumber: "2026-15000",
      publicationDate: "2026-07-23",
      signingDate: "2026-07-20",
      signingLagDays: 3,
    },
    PRODUCT_RECALL: {
      factLine: "FDA Class II recall: Chiesi USA, Inc. CLEVIPREX. Reason: Lack of Assurance of Sterility",
      firm: "Chiesi USA, Inc.",
      classification: "Class II",
      reason: "Lack of Assurance of Sterility",
      status: "Ongoing",
      initiatedIso: "2026-07-06",
      reportedIso: "2026-07-22",
      disclosureLagDays: 16,
      voluntaryIsFirmInitiated: true,
    },
    TREASURY_AUCTION: {
      factLine: "US Treasury 2-Year Note auction 2026-07-27: high yield 4.315%, bid-to-cover 2.66, $69.0B offered",
      securityTerm: "2-Year",
      securityType: "Note",
      highYield: 4.315,
      bidToCoverRatio: 2.66,
      allocationPercentage: 69.04,
      indirectPct: 56.6,
    },
    RATE_DECISION: {
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
    HALT: {
      symbol: "STKH",
      name: "Steakholder Foods Ltd. ADS",
      reasonText: "News Pending",
      reasonCode: "T1",
      haltTimeEtShort: "19:50",
      haltCountToday: 1,
    },
  };

  it("every archetype renders text the poster will actually publish", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    for (const a of ALL) {
      const payload = REPRESENTATIVE[a.id];
      expect(payload, `no representative payload for ${a.id}`).toBeDefined();
      const r = renderPost(a, payload!, { seed: `guard:${a.id}` });
      expect(r.ok, `${a.id} failed to render`).toBe(true);
      if (!r.ok) continue;
      const issues = checkRegister(r.text, a.id);
      expect(issues.map((i) => `${i.rule}: ${i.detail}`), `${a.id} would be BLOCKED at publish: ${r.text}`).toEqual([]);
    }
  });

  it("every beat, rendered onto its archetype, also survives the guard", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    for (const a of ALL) {
      const payload = REPRESENTATIVE[a.id]!;
      for (const beat of a.beats) {
        // Render the fact block, then append this specific beat's text.
        const r = renderPost(a, payload, { seed: `beat:${a.id}` });
        if (!r.ok) continue;
        const factBlock = r.text.split("\n\n")[0]!;
        const issues = checkRegister(`${factBlock}\n\n${beat.text}`, a.id);
        expect(issues.map((i) => i.rule), `${a.id}/${beat.id} would be blocked: "${beat.text}"`).toEqual([]);
      }
    }
  });
});

describe("doctrine: rotation quality", () => {
  it("sequential item ids do not produce a fixed beat cycle", () => {
    const payload = { company: "ACME", formType: "8-K", items: [{ code: "4.02", title: "Non-Reliance" }], itemCodes: ["4.02"] };
    const picks: string[] = [];
    for (let i = 1000; i < 1020; i++) {
      const r = renderPost(ARCHETYPES.FILING_8K, payload, { seed: `FILING_8K:${i}` });
      if (r.ok) picks.push(`${r.skeletonId}|${r.beatId ?? "none"}`);
    }
    // A period-2 or period-4 cycle would mean the seed's low bits are a
    // counter, which is the machine-detectable pattern rotation must avoid.
    const period2 = picks.every((p, i) => i < 2 || p === picks[i - 2]);
    const period4 = picks.every((p, i) => i < 4 || p === picks[i - 4]);
    expect(period2).toBe(false);
    expect(period4).toBe(false);
  });
});

describe("doctrine: register checks on hand-written edits", () => {
  it("rejects em-dashes, hashtags, questions, advice, overlength, missing attribution", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    expect(checkRegister("Fine text, per SEC", "FILING_8K")).toEqual([]);
    expect(checkRegister("Bad — dash, per SEC", "FILING_8K").map((i) => i.rule)).toContain("em_dash");
    expect(checkRegister("#tag, per SEC", "FILING_8K").map((i) => i.rule)).toContain("hashtag");
    expect(checkRegister("Really, per SEC?", "FILING_8K").map((i) => i.rule)).toContain("question");
    expect(checkRegister("You should buy this, per SEC", "FILING_8K").map((i) => i.rule)).toContain("advice");
    expect(checkRegister("x".repeat(600), "FILING_8K").map((i) => i.rule)).toContain("length");
    expect(checkRegister("No source here", "FILING_8K").map((i) => i.rule)).toContain("attribution");
  });
});

describe("rotation", () => {
  it("never repeats a beat used in the recent window; falls back to no beat", () => {
    const payload = { factLine: "x", lagDays: 45, amountBand: "$1,001 - $15,000", tradeDate: "06/24/2026", filedDate: "07/24/2026" };
    const usedIds = ARCHETYPES.CONGRESS_PTR.beats.map((b) => b.id);
    const picked = pickBeat(ARCHETYPES.CONGRESS_PTR, payload, { recentSkeletons: [], recentBeats: usedIds }, 3);
    expect(picked).toBeNull(); // exhausted -> no beat, NEVER a repeat
  });

  it("consecutive renders with rotation state pick different beats", () => {
    const payload = {
      factLine: "x",
      who: "Senator Example",
      tradeLine: "Purchase $1,001 - $15,000, ACME (06/24/2026)",
      filedDate: "07/24/2026",
      lagDays: 45,
    };
    const first = renderPost(ARCHETYPES.CONGRESS_PTR, payload, { seed: "a" });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.beatId) return;
    const second = renderPost(ARCHETYPES.CONGRESS_PTR, payload, {
      seed: "b",
      rotation: { recentSkeletons: [first.skeletonId], recentBeats: [first.beatId] },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.beatId).not.toBe(first.beatId);
    expect(second.skeletonId).not.toBe(first.skeletonId);
  });

  it("escalation beats outrank base beats when their gate qualifies", () => {
    const picked = pickBeat(ARCHETYPES.CONGRESS_PTR, { lagDays: 45 }, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(picked?.beat.tier).toBe("escalation");
  });

  it("renders are deterministic for the same seed (approved == posted)", () => {
    const payload = { factLine: "x", lagDays: 10 };
    const a = renderPost(ARCHETYPES.CONGRESS_PTR, payload, { seed: "item:42" });
    const b = renderPost(ARCHETYPES.CONGRESS_PTR, payload, { seed: "item:42" });
    expect(a).toEqual(b);
    expect(seedHash("item:42")).toBe(seedHash("item:42"));
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION

describe("render integration", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("8-K renders SEC item titles verbatim with attribution and a gated beat", () => {
    const r = renderPost(
      ARCHETYPES.FILING_8K,
      {
        company: "ACME CORP",
        formType: "8-K",
        items: [{ code: "4.02", title: "Non-Reliance on Previously Issued Financial Statements" }],
        itemCodes: ["4.02"],
      },
      { seed: "8k:1" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("ACME CORP");
    expect(r.text).toContain("Non-Reliance on Previously Issued Financial Statements");
    expect(r.text).toContain("per SEC");
    expect(r.text).not.toContain("—");
    // 4.02-gated beat is eligible.
    expect(["8k.retraction", "8k.ownclaim"]).toContain(r.beatId);
  });

  it("a 4.02 beat cannot attach to a filing without 4.02", () => {
    const r = renderPost(
      ARCHETYPES.FILING_8K,
      { company: "X", formType: "8-K", items: [{ code: "8.01", title: "Other Events" }], itemCodes: ["8.01"] },
      { seed: "8k:2" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.beatId).not.toBe("8k.retraction");
    expect(r.text).not.toContain("Non-reliance is the accounting");
  });

  it("unrenderable payload fails closed rather than posting a stub", () => {
    const r = renderPost(ARCHETYPES.FILING_8K, { formType: "8-K" }, { seed: "empty" });
    expect(r.ok).toBe(false);
  });

  it("enqueue renders at queue time and records the rotation ledger", async () => {
    const item = await insertItem(env.DB, {
      source: "halt",
      externalId: "T-1",
      category: "halt",
      eventAt: null,
      sourceUrl: "https://www.nasdaqtrader.com/x",
      payload: {},
      score: SCORE_POSTABLE,
    });
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: "/botTEST:TOKEN/sendMessage", method: "POST" })
      .reply(200, JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 424242 } } }));

    const { queueId } = await enqueueForApproval(
      env,
      item.id ?? 0,
      "HALT",
      { symbol: "STKH", name: "Steakholder Foods", reasonText: "News Pending", reasonCode: "T1", haltTimeEtShort: "19:50" },
      "https://www.nasdaqtrader.com/x",
    );

    const row = await env.DB.prepare("SELECT draft_text, skeleton_id, beat_id, archetype FROM queue WHERE id = ?1")
      .bind(queueId)
      .first<{ draft_text: string; skeleton_id: string; beat_id: string | null; archetype: string }>();
    expect(row?.archetype).toBe("HALT");
    expect(row?.draft_text).toContain("STKH");
    expect(row?.draft_text).toContain("per Nasdaq");
    expect(row?.skeleton_id).toBeTruthy();

    const rotation = await loadRotation(env, "HALT");
    expect(rotation.recentSkeletons).toContain(row?.skeleton_id);
  });

  it("renderForQueue survives a rotation lookup failure", async () => {
    const broken = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
      DB: { prepare: () => { throw new Error("d1 down"); } },
    });
    const r = await renderForQueue(broken, "HALT" as ArchetypeId, { symbol: "X", reasonText: "News Pending", reasonCode: "T1", haltTimeEtShort: "10:00" }, "s");
    expect(r.ok).toBe(true);
  });
});

describe("doctrine: the advice guard is narrow on purpose", () => {
  // It produced three false positives and zero true ones before this was
  // tightened: "filed notice to sell" (Form 144), "coming up short"
  // (Treasury) and "leveraged funds net short" (CFTC) are all factual
  // descriptions of a parsed record.
  it("permits the vocabulary of markets when it describes a record", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const factual = [
      "Bender Investment Company filed notice of a proposed sale of 100,000 shares, per SEC Form 144",
      "CFTC positioning: leveraged funds net short 361,875 E-MINI S&P 500 contracts, per CFTC",
      "Form 4: Jane Doe (CEO) sold 600,000 ACME at ~$12.00, per SEC Form 4",
      "Short interest rose to 12.4% of float, per FINRA",
    ];
    for (const t of factual) {
      expect(checkRegister(t).filter((i) => i.rule === "advice"), t).toEqual([]);
    }
  });

  it("still blocks actual advice", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const advice = [
      "Buy this one before earnings, per SEC",
      "You should sell into the rally, per SEC",
      "Bullish setup here, per SEC",
      "Price target $200, per SEC",
      "This will rally into year end, per SEC",
      "Worth buying at these levels, per SEC",
    ];
    for (const t of advice) {
      expect(checkRegister(t).map((i) => i.rule), t).toContain("advice");
    }
  });
});
