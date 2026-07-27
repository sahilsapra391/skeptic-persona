-- P3: backfill lookback_facts from 8-K items already in the lake.
--
-- recordFacts only fires on NEW inserts, so the engine would start from zero
-- even though ~190 parsed 8-Ks are already stored. Without this, "second
-- non-reliance this year" cannot fire for any issuer whose first filing we
-- ingested during P1 — the beat would be silently wrong-by-omission.
--
-- json_each expands the parsed itemCodes array into one fact per code, which
-- is exactly what the ingester writes going forward. INSERT OR IGNORE plus
-- the UNIQUE(item_id, entity, metric) key makes this safe to re-run and safe
-- to overlap with live ingestion.
INSERT OR IGNORE INTO lookback_facts (item_id, source, entity, metric, value, occurred_at, recorded_at)
SELECT
  i.id,
  'edgar_8k',
  json_extract(i.payload, '$.cik'),
  '8k.item.' || code.value,
  NULL,
  COALESCE(i.event_at, i.fetched_at),
  i.fetched_at
FROM items i, json_each(json_extract(i.payload, '$.itemCodes')) AS code
WHERE i.source = 'edgar_8k'
  AND json_extract(i.payload, '$.cik') IS NOT NULL
  AND json_extract(i.payload, '$.cik') <> ''
  AND COALESCE(i.event_at, i.fetched_at) IS NOT NULL;

-- Coverage opens at the OLDEST event we actually backfilled, not at now:
-- claiming a 90-day window we never observed would be the exact fabrication
-- the engine's honesty guard exists to prevent. It also must not overwrite an
-- existing (earlier) opening.
-- HAVING, not WHERE: an aggregate over zero rows still returns ONE row whose
-- MIN is NULL, which would violate observed_from NOT NULL on a fresh database
-- (every test run applies these migrations against an empty schema).
INSERT INTO lookback_coverage (source, metric, observed_from, updated_at)
SELECT 'edgar_8k', '*', MIN(occurred_at), datetime('now')
FROM lookback_facts WHERE source = 'edgar_8k'
HAVING MIN(occurred_at) IS NOT NULL
ON CONFLICT(source) DO UPDATE SET
  observed_from = MIN(lookback_coverage.observed_from, excluded.observed_from),
  updated_at = excluded.updated_at;
