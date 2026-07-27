import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  countSince,
  coverageFor,
  lookbackFieldsFor,
  MIN_SUPERLATIVE_COVERAGE_DAYS,
  priorValue,
  rankValue,
  recordFacts,
} from "../src/lookback";
import { insertItem, SCORE_LOG_ONLY } from "../src/lib/db";

const NOW = new Date("2026-07-27T12:00:00Z");
const SRC = "test_src";

let seq = 0;
async function seedItem(): Promise<number> {
  const res = await insertItem(env.DB, {
    source: SRC,
    externalId: `LB-${++seq}`,
    category: "test",
    eventAt: null,
    sourceUrl: "https://example.gov/x",
    payload: {},
    score: SCORE_LOG_ONLY,
    status: "logged",
  });
  return res.id ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM lookback_facts").run();
  await env.DB.prepare("DELETE FROM lookback_coverage").run();
});

describe("recordFacts", () => {
  it("is idempotent on (item, entity, metric): re-ingesting cannot inflate a count", async () => {
    const id = await seedItem();
    const fact = { itemId: id, source: SRC, entity: "CIK1", metric: "8k.item.4.02", occurredAt: "2026-07-20T00:00:00.000Z" };

    expect(await recordFacts(env.DB, [fact], NOW)).toBe(1);
    expect(await recordFacts(env.DB, [fact], NOW)).toBe(0); // replay is a no-op
    expect(await countSince(env.DB, { source: SRC, entity: "CIK1", metric: "8k.item.4.02", since: "2026-01-01T00:00:00.000Z" })).toBe(1);
  });

  it("opens coverage on first write and never moves it forward", async () => {
    const a = await seedItem();
    await recordFacts(env.DB, [{ itemId: a, source: SRC, entity: "E", metric: "m", occurredAt: "2026-07-01T00:00:00.000Z" }], new Date("2026-01-01T00:00:00Z"));
    const first = await coverageFor(env.DB, SRC, NOW);

    const b = await seedItem();
    await recordFacts(env.DB, [{ itemId: b, source: SRC, entity: "E", metric: "m", occurredAt: "2026-07-02T00:00:00.000Z" }], NOW);
    const second = await coverageFor(env.DB, SRC, NOW);

    // A window that appeared to shrink would make yesterday's honest claim
    // dishonest today.
    expect(second.observedFrom).toBe(first.observedFrom);
    expect(second.days).toBeGreaterThanOrEqual(first.days);
  });
});

describe("the honesty constraint", () => {
  it("refuses a record claim when the observed window is too short", async () => {
    const id = await seedItem();
    // Coverage opens TODAY: we have hours of history, not years.
    await recordFacts(env.DB, [{ itemId: id, source: SRC, entity: "E", metric: "size", value: 100, occurredAt: "2026-07-27T00:00:00.000Z" }], NOW);

    const rank = await rankValue(env.DB, { source: SRC, metric: "size", value: 999 }, NOW);
    expect(rank.higherCount).toBe(0); // genuinely the largest we hold
    expect(rank.coverage.sufficientForSuperlative).toBe(false);
    expect(rank.isRecordHigh).toBe(false); // ...and we still refuse to say so
  });

  it("allows the record claim once the window is long enough", async () => {
    const id = await seedItem();
    const openedAt = new Date(NOW.getTime() - (MIN_SUPERLATIVE_COVERAGE_DAYS + 1) * 86_400_000);
    await recordFacts(env.DB, [{ itemId: id, source: SRC, entity: "E", metric: "size", value: 100, occurredAt: "2026-05-01T00:00:00.000Z" }], openedAt);

    const rank = await rankValue(env.DB, { source: SRC, metric: "size", value: 999 }, NOW);
    expect(rank.coverage.days).toBeGreaterThanOrEqual(MIN_SUPERLATIVE_COVERAGE_DAYS);
    expect(rank.isRecordHigh).toBe(true);
  });

  it("a single data point is never a record, however long the window", async () => {
    const openedAt = new Date(NOW.getTime() - 400 * 86_400_000);
    // Coverage exists but no VALUES have been recorded.
    await env.DB.prepare(
      "INSERT INTO lookback_coverage (source, metric, observed_from, updated_at) VALUES (?1, '*', ?2, ?2)",
    )
      .bind(SRC, openedAt.toISOString())
      .run();

    const rank = await rankValue(env.DB, { source: SRC, metric: "size", value: 999 }, NOW);
    expect(rank.total).toBe(0);
    expect(rank.isRecordHigh).toBe(false);
  });

  it("coverage is null for a source we have never observed", async () => {
    const c = await coverageFor(env.DB, "never_seen", NOW);
    expect(c).toMatchObject({ observedFrom: null, days: 0, sufficientForSuperlative: false });
  });
});

describe("countSince", () => {
  it("counts only the same entity and metric, and excludes the item being rendered", async () => {
    const ids = [await seedItem(), await seedItem(), await seedItem()];
    await recordFacts(
      env.DB,
      [
        { itemId: ids[0]!, source: SRC, entity: "CIK1", metric: "8k.item.4.02", occurredAt: "2026-03-01T00:00:00.000Z" },
        { itemId: ids[1]!, source: SRC, entity: "CIK1", metric: "8k.item.4.02", occurredAt: "2026-06-01T00:00:00.000Z" },
        { itemId: ids[2]!, source: SRC, entity: "CIK2", metric: "8k.item.4.02", occurredAt: "2026-06-01T00:00:00.000Z" },
      ],
      NOW,
    );

    const year = "2026-01-01T00:00:00.000Z";
    // Rendering item[1]: one PRIOR filing from this issuer.
    expect(await countSince(env.DB, { source: SRC, entity: "CIK1", metric: "8k.item.4.02", since: year, excludeItemId: ids[1] })).toBe(1);
    // A different issuer's filing never counts toward this one.
    expect(await countSince(env.DB, { source: SRC, entity: "CIK2", metric: "8k.item.4.02", since: year, excludeItemId: ids[2] })).toBe(0);
    // A different item code never counts either.
    expect(await countSince(env.DB, { source: SRC, entity: "CIK1", metric: "8k.item.5.02", since: year })).toBe(0);
  });

  it("respects the since boundary", async () => {
    const id = await seedItem();
    await recordFacts(env.DB, [{ itemId: id, source: SRC, entity: "E", metric: "m", occurredAt: "2025-12-31T00:00:00.000Z" }], NOW);
    expect(await countSince(env.DB, { source: SRC, entity: "E", metric: "m", since: "2026-01-01T00:00:00.000Z" })).toBe(0);
  });
});

describe("priorValue", () => {
  it("returns the most recent value strictly before the anchor", async () => {
    const ids = [await seedItem(), await seedItem()];
    await recordFacts(
      env.DB,
      [
        { itemId: ids[0]!, source: SRC, entity: "CPI", metric: "mom", value: 0.5, occurredAt: "2026-05-01T00:00:00.000Z" },
        { itemId: ids[1]!, source: SRC, entity: "CPI", metric: "mom", value: -0.4, occurredAt: "2026-06-01T00:00:00.000Z" },
      ],
      NOW,
    );
    const prior = await priorValue(env.DB, { source: SRC, entity: "CPI", metric: "mom", before: "2026-06-01T00:00:00.000Z" });
    expect(prior).toMatchObject({ value: 0.5, occurredAt: "2026-05-01T00:00:00.000Z" });

    // Nothing before the first observation.
    expect(await priorValue(env.DB, { source: SRC, entity: "CPI", metric: "mom", before: "2026-05-01T00:00:00.000Z" })).toBeNull();
  });
});

describe("lookbackFieldsFor", () => {
  it("produces gate-ready fields that fail closed when the lake is empty", async () => {
    const fields = await lookbackFieldsFor(
      env.DB,
      { source: "unseen", entity: "X", metric: "m", since: "2026-01-01T00:00:00.000Z" },
      NOW,
    );
    expect(fields.priorCount).toBe(0);
    expect(fields.occurrence).toBe(1); // this is the FIRST, so no escalation
    expect(fields.coverageDays).toBeNull();
    expect(fields.recordHigh).toBeNull();
  });

  it("numbers the occurrence so a beat can say which filing this is", async () => {
    const ids = [await seedItem(), await seedItem()];
    await recordFacts(
      env.DB,
      [
        { itemId: ids[0]!, source: SRC, entity: "CIK1", metric: "8k.item.4.02", occurredAt: "2026-03-01T00:00:00.000Z" },
        { itemId: ids[1]!, source: SRC, entity: "CIK1", metric: "8k.item.4.02", occurredAt: "2026-06-01T00:00:00.000Z" },
      ],
      NOW,
    );
    const fields = await lookbackFieldsFor(
      env.DB,
      { source: SRC, entity: "CIK1", metric: "8k.item.4.02", since: "2026-01-01T00:00:00.000Z", itemId: ids[1] },
      NOW,
    );
    expect(fields.priorCount).toBe(1);
    expect(fields.occurrence).toBe(2); // "Second non-reliance filing..."
  });
});
