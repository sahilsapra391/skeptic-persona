import { iso } from "./lib/time";

// The lookback engine. Answers the three questions persona.md section 11
// requires before any streak, record, or "first time since" claim may render:
//
//   1. How many times has THIS entity done THIS since T?      (countSince)
//   2. Is this value the highest/lowest we have ever recorded? (rankValue)
//   3. What did this series read last time?                    (priorValue)
//
// THE HONESTY CONSTRAINT, which is the whole design:
// a superlative is only as true as the window we have actually observed. This
// pipeline began recording on 2026-07-27. "Highest since 2019" from three
// days of data is fabrication with correct arithmetic behind it. So every
// answer carries the coverage window that produced it, and claims that need
// more history than we hold are refused rather than softened.

/** Minimum observed window before a "first/highest since" claim may render. */
export const MIN_SUPERLATIVE_COVERAGE_DAYS = 90;

export interface LookbackFact {
  itemId: number;
  source: string;
  entity: string;
  metric: string;
  value?: number | null;
  occurredAt: string; // ISO UTC of the EVENT
}

/**
 * Record facts for an item. Idempotent on (item_id, entity, metric): an
 * ingester re-processing the same filing must never inflate a count.
 * Coverage is opened on first write per source and never moves backwards.
 */
export async function recordFacts(
  db: D1Database,
  facts: readonly LookbackFact[],
  now: Date = new Date(),
): Promise<number> {
  if (facts.length === 0) return 0;
  const nowIso = iso(now);
  const stmts = facts.map((f) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO lookback_facts
           (item_id, source, entity, metric, value, occurred_at, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(f.itemId, f.source, f.entity, f.metric, f.value ?? null, f.occurredAt, nowIso),
  );
  // Coverage opens at the first fact we ever record for a source. It must
  // never move forward on later writes, or the window would appear to shrink
  // and a claim that was honest yesterday would become dishonest today.
  for (const source of new Set(facts.map((f) => f.source))) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO lookback_coverage (source, metric, observed_from, updated_at)
           VALUES (?1, '*', ?2, ?2)
           ON CONFLICT(source) DO UPDATE SET updated_at = ?2`,
        )
        .bind(source, nowIso),
    );
  }
  const results = await db.batch(stmts);
  return results.slice(0, facts.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export interface Coverage {
  /** ISO UTC when we began observing this source, or null if never. */
  observedFrom: string | null;
  days: number;
  /** True when the window is long enough to support a superlative claim. */
  sufficientForSuperlative: boolean;
}

export async function coverageFor(db: D1Database, source: string, now: Date = new Date()): Promise<Coverage> {
  const row = await db
    .prepare(`SELECT observed_from FROM lookback_coverage WHERE source = ?1`)
    .bind(source)
    .first<{ observed_from: string }>();
  if (!row) return { observedFrom: null, days: 0, sufficientForSuperlative: false };
  const from = new Date(row.observed_from);
  if (Number.isNaN(from.getTime())) return { observedFrom: null, days: 0, sufficientForSuperlative: false };
  const days = Math.floor((now.getTime() - from.getTime()) / 86_400_000);
  return {
    observedFrom: row.observed_from,
    days,
    sufficientForSuperlative: days >= MIN_SUPERLATIVE_COVERAGE_DAYS,
  };
}

/**
 * Occurrences of (entity, metric) at or after `since`, EXCLUDING the item
 * being rendered — the caller wants "how many came before this one".
 */
export async function countSince(
  db: D1Database,
  opts: { source: string; entity: string; metric: string; since: string; excludeItemId?: number },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM lookback_facts
       WHERE source = ?1 AND entity = ?2 AND metric = ?3 AND occurred_at >= ?4
         AND (?5 IS NULL OR item_id <> ?5)`,
    )
    .bind(opts.source, opts.entity, opts.metric, opts.since, opts.excludeItemId ?? null)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface Rank {
  /** How many recorded values are strictly greater. 0 = the highest we hold. */
  higherCount: number;
  lowerCount: number;
  total: number;
  /** Event date of the last value that was >= this one, if any. */
  lastAtLeastAt: string | null;
  coverage: Coverage;
  /**
   * True only when this is the highest we hold AND the window is long enough
   * to say so. The engine refuses rather than softens.
   */
  isRecordHigh: boolean;
  isRecordLow: boolean;
}

export async function rankValue(
  db: D1Database,
  opts: { source: string; metric: string; value: number; entity?: string; excludeItemId?: number },
  now: Date = new Date(),
): Promise<Rank> {
  const entityClause = opts.entity ? "AND entity = ?5" : "";
  const binds: unknown[] = [opts.source, opts.metric, opts.value, opts.excludeItemId ?? null];
  if (opts.entity) binds.push(opts.entity);

  const agg = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN value > ?3 THEN 1 ELSE 0 END) AS higher,
         SUM(CASE WHEN value < ?3 THEN 1 ELSE 0 END) AS lower,
         COUNT(*) AS total,
         MAX(CASE WHEN value >= ?3 THEN occurred_at END) AS last_at_least
       FROM lookback_facts
       WHERE source = ?1 AND metric = ?2 AND value IS NOT NULL
         AND (?4 IS NULL OR item_id <> ?4) ${entityClause}`,
    )
    .bind(...binds)
    .first<{ higher: number | null; lower: number | null; total: number; last_at_least: string | null }>();

  const coverage = await coverageFor(db, opts.source, now);
  const higherCount = agg?.higher ?? 0;
  const lowerCount = agg?.lower ?? 0;
  const total = agg?.total ?? 0;
  return {
    higherCount,
    lowerCount,
    total,
    lastAtLeastAt: agg?.last_at_least ?? null,
    coverage,
    // A record claim needs BOTH a genuine extreme and enough observed history
    // to make the word "record" mean anything. One data point is not a record.
    isRecordHigh: total > 0 && higherCount === 0 && coverage.sufficientForSuperlative,
    isRecordLow: total > 0 && lowerCount === 0 && coverage.sufficientForSuperlative,
  };
}

/** The most recent value for (entity, metric) strictly before `before`. */
export async function priorValue(
  db: D1Database,
  opts: { source: string; entity: string; metric: string; before: string },
): Promise<{ value: number; occurredAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT value, occurred_at FROM lookback_facts
       WHERE source = ?1 AND entity = ?2 AND metric = ?3 AND occurred_at < ?4 AND value IS NOT NULL
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    .bind(opts.source, opts.entity, opts.metric, opts.before)
    .first<{ value: number; occurred_at: string }>();
  return row ? { value: row.value, occurredAt: row.occurred_at } : null;
}

/**
 * Payload fields a template can gate on, derived ONLY from what the lake
 * actually holds. Every field is null when the lookback cannot support it,
 * so a gate on a missing field fails closed exactly like any other field.
 */
export interface LookbackFields {
  priorCount: number | null;
  occurrence: number | null;
  /** Set only when the window is long enough AND the value is a true extreme. */
  recordHigh: boolean | null;
  /** ISO date of the last time this metric was at least this high. */
  lastAtLeast: string | null;
  coverageDays: number | null;
}

export async function lookbackFieldsFor(
  db: D1Database,
  opts: { source: string; entity: string; metric: string; since: string; value?: number | null; itemId?: number },
  now: Date = new Date(),
): Promise<LookbackFields> {
  const priorCount = await countSince(db, {
    source: opts.source,
    entity: opts.entity,
    metric: opts.metric,
    since: opts.since,
    excludeItemId: opts.itemId,
  });
  const coverage = await coverageFor(db, opts.source, now);
  const fields: LookbackFields = {
    priorCount,
    occurrence: priorCount + 1,
    recordHigh: null,
    lastAtLeast: null,
    coverageDays: coverage.observedFrom === null ? null : coverage.days,
  };
  if (typeof opts.value === "number" && Number.isFinite(opts.value)) {
    const rank = await rankValue(
      db,
      { source: opts.source, metric: opts.metric, value: opts.value, excludeItemId: opts.itemId },
      now,
    );
    fields.recordHigh = rank.isRecordHigh;
    fields.lastAtLeast = rank.lastAtLeastAt;
  }
  return fields;
}
