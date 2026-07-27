-- P3: the lookback engine.
--
-- persona.md section 11: "Never streaks or records without a queried
-- lookback." Four owner-signed beats are disabled waiting for exactly this,
-- and the superlative frame ("highest since {date}") is the best-performing
-- skeleton across every competitor corpus we measured.
--
-- WHY A FACT TABLE rather than querying items.payload: the questions are
-- "how many times has THIS entity done THIS since T" and "is this value the
-- highest we have ever recorded". Both need an index, and SQLite cannot index
-- into a JSON blob without a generated column per field. One narrow, indexed
-- table answers every lookback question at a fixed cost.
CREATE TABLE lookback_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  source TEXT NOT NULL,
  -- The thing the fact is ABOUT: an issuer CIK, a ticker, a member name.
  -- Normalized by the recorder, never by the reader.
  entity TEXT NOT NULL,
  -- What is being counted or measured: '8k.item.4.02', 'halt.LUDP',
  -- 'ptr.lagDays', 'cpi.momSigned'. Namespaced by source so two ingesters
  -- can never collide on a name.
  metric TEXT NOT NULL,
  -- Numeric value when the metric is measurable; NULL for pure occurrences.
  value REAL,
  -- When the EVENT happened (not when we saw it): the filing date, the halt
  -- time, the reference period. ISO-8601 UTC.
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  -- One fact per (item, entity, metric): re-running an ingester over the same
  -- filing must not inflate a count. This is the whole idempotency story.
  UNIQUE(item_id, entity, metric)
);

-- Occurrence counting: "how many 4.02s has this issuer filed since January".
CREATE INDEX idx_lookback_entity ON lookback_facts(source, entity, metric, occurred_at DESC);
-- Extremes across all entities: "is this the largest we have recorded".
CREATE INDEX idx_lookback_metric ON lookback_facts(source, metric, value);

-- Coverage: the honesty guard. A superlative is only as true as the window we
-- have actually observed, and this pipeline started on 2026-07-27. Claiming
-- "highest since 2019" from three days of data would be fabrication even
-- though the arithmetic is sound. Every source records when its observation
-- window opened, and the engine refuses superlatives on a window too short to
-- support them.
CREATE TABLE lookback_coverage (
  source TEXT PRIMARY KEY,
  metric TEXT NOT NULL DEFAULT '*',
  observed_from TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
