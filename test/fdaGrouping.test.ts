import { describe, expect, it } from "vitest";
import FDA from "./fixtures/fda-drug-enforcement.json.fixture?raw";
import { draftRecall, eventKey, FDA_SOURCES, groupRecalls, parseRecalls, scoreRecall } from "../src/ingesters/fdaRecalls";
import { SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";

// Live openFDA drug enforcement records, captured 2026-07-28. Three real
// events chosen for what they prove:
//   98731 - 8 records spanning Class I AND Class II (the split-grade case)
//   99098 - 23 records, Guardian Drug Co. (the flood case)
//   99376 - 1 record (the ordinary case)

const records = parseRecalls(FDA);

describe("openFDA publishes per PRODUCT, not per recall", () => {
  it("collapses 32 product records into 6 events", () => {
    expect(records.length).toBe(32);
    expect(groupRecalls(records).length).toBe(6);
  });

  it("turns one 23-product recall into ONE card, not 23", () => {
    // The flood this exists for. Ungrouped, Guardian Drug Co. alone would
    // have produced 23 near-identical approval cards for one recall.
    const guardian = groupRecalls(records).filter((e) => e.eventId === "99098");
    expect(guardian.length).toBe(1);
    expect(guardian[0]!.productCount).toBe(23);
    expect(guardian[0]!.products.length).toBe(23);
  });

  it("does NOT merge products FDA graded differently", () => {
    // Event 98731 carries both Class I and Class II. Grouping on event_id
    // alone would print one grade over products the agency graded
    // differently, which mis-states the agency's own call.
    const raw = records.filter((r) => r.eventId === "98731");
    expect(new Set(raw.map((r) => r.classification)).size).toBe(2);

    const grouped = groupRecalls(records).filter((e) => e.eventId === "98731");
    expect(grouped.length).toBeGreaterThan(1);
    for (const g of grouped) {
      // Every product in a group shares the grade the card will state.
      const members = raw.filter((r) => eventKey(r) === eventKey(g));
      expect(members.length).toBe(g.productCount);
      expect(new Set(members.map((r) => r.classification)).size).toBe(1);
      expect(new Set(members.map((r) => r.reason)).size).toBe(1);
    }
  });

  it("never merges a field that differs between its members", () => {
    // The invariant the composite key buys. Measured across a 307-record
    // food window and a 199-record drug window: zero inconsistent groups.
    for (const g of groupRecalls(records)) {
      const members = records.filter((r) => eventKey(r) === eventKey(g));
      for (const field of ["firm", "classification", "reason", "status", "initiatedIso", "reportedIso"] as const) {
        expect(new Set(members.map((r) => r[field])).size, `${g.eventId} ${field}`).toBe(1);
        expect(g[field], `${g.eventId} ${field}`).toBe(members[0]![field]);
      }
    }
  });

  it("counts exactly what it lists", () => {
    for (const g of groupRecalls(records)) {
      expect(g.productCount).toBe(g.products.length);
    }
  });
});

describe("the draft says how many products it covers", () => {
  it("marks the elision rather than reading as a single-product recall", () => {
    const guardian = groupRecalls(records).find((e) => e.eventId === "99098")!;
    const draft = draftRecall(guardian);
    // Same convention as the congressional trade list: a truncated list that
    // does not say it is truncated reads as complete.
    expect(draft).toContain("+22 more products");
    expect(draft).toContain(guardian.firm);
    expect(draft).toContain(guardian.classification);
  });

  it("says nothing about extra products when there is only one", () => {
    const single = groupRecalls(records).find((e) => e.productCount === 1)!;
    expect(draftRecall(single)).not.toMatch(/more products/);
  });

  it("still grades on FDA's own classification, never on the reason text", () => {
    const grouped = groupRecalls(records);
    for (const g of grouped) {
      if (g.classification === "Class I") expect(scoreRecall(g)).toBe(SCORE_AUTO_ALERT);
      if (g.classification === "Class II") expect(scoreRecall(g)).toBe(SCORE_POSTABLE);
    }
  });
});

describe("eventKey", () => {
  it("is stable for the same event, grade and reason", () => {
    const a = records.find((r) => r.eventId === "99098")!;
    const b = records.filter((r) => r.eventId === "99098")[1]!;
    expect(eventKey(a)).toBe(eventKey(b));
  });

  it("separates a restated reason into its own item", () => {
    // If FDA restates WHY a product was pulled, that is a different claim
    // and deserves its own card rather than silently reusing the old one.
    const a = records[0]!;
    expect(eventKey({ ...a, reason: "Different reason entirely" })).not.toBe(eventKey(a));
  });
});

describe("the food dataset shares the drug parser, not its editorial gate", () => {
  const drug = FDA_SOURCES.find((s) => s.id === "fda_drug_recall")!;
  const food = FDA_SOURCES.find((s) => s.id === "fda_food_recall")!;

  it("hits the same openFDA enforcement shape", () => {
    expect(food.url).toContain("api.fda.gov/food/enforcement.json");
    expect(drug.url).toContain("api.fda.gov/drug/enforcement.json");
    // Field parity verified live 2026-07-28: every field parseRecalls reads
    // is present in the food dataset, so one parser covers both.
    expect(food.kind).toBe("food");
  });

  it("lets a Class II DRUG recall through and holds a Class II FOOD recall", () => {
    // Measured 2026-07-28: food Class II runs ~33 grouped events a month,
    // mostly undeclared allergens at regional producers. Real public-health
    // notices, but not market intelligence, and the queue already expires
    // more cards than it approves.
    const classII = groupRecalls(records).find((e) => e.classification === "Class II")!;
    expect(scoreRecall(classII, drug)).toBe(SCORE_POSTABLE);
    expect(scoreRecall(classII, food)).toBe(SCORE_LOG_ONLY);
  });

  it("lets Class I through on BOTH, because that is FDA's serious-harm grade", () => {
    const classI = groupRecalls(records).find((e) => e.classification === "Class I")!;
    expect(scoreRecall(classI, drug)).toBe(SCORE_AUTO_ALERT);
    expect(scoreRecall(classI, food)).toBe(SCORE_AUTO_ALERT);
  });

  it("never posts a recall it cannot describe, whatever the grade", () => {
    const classI = groupRecalls(records).find((e) => e.classification === "Class I")!;
    expect(scoreRecall({ ...classI, reason: "" }, food)).toBe(SCORE_LOG_ONLY);
    expect(scoreRecall({ ...classI, product: "" }, drug)).toBe(SCORE_LOG_ONLY);
  });
});
