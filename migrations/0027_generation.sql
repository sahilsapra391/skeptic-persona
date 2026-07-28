-- P2-R p2r-04: the generation layer (docs/p2r-plan.md Part D).
--
-- On Approve, a job turns the approved item into three copy-ready variants
-- (dry / sharp / commentary) via OpenRouter, each validated against the
-- no-fabrication floor and the commentary contract before the owner ever
-- sees it. This migration adds the storage and the job row.

-- Every generation attempt, kept as an audit trail: what the model produced,
-- what the validators said, and the shape fingerprints the collision checks
-- compare against. Rejected attempts are rows too — "what did the validator
-- refuse and why" must be answerable by SQL, not by re-running the model.
CREATE TABLE generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL REFERENCES queue(id),
  -- 'none' is the exemplar-gate marker: generation was REFUSED (no owner
  -- exemplar for the archetype) and the card falls back to the template
  -- draft. A marker row is what keeps the job from re-picking the queue row
  -- every tick.
  variant TEXT NOT NULL CHECK (variant IN ('dry', 'sharp', 'commentary', 'none')),
  text TEXT NOT NULL,                  -- '' for variant='none'
  skeleton_hash TEXT NOT NULL,         -- masked-shape hash; cross-archetype collision check
  opener_hash TEXT NOT NULL,           -- first-4-content-tokens hash; opener collision check
  -- 'valid' | 'rejected:<rule>' | 'skipped_no_exemplar' | 'fallback_template'
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,  -- 1 = first pass, 2 = the one regenerate
  created_at TEXT NOT NULL,
  UNIQUE (queue_id, variant, attempt)
);
CREATE INDEX idx_generations_queue ON generations(queue_id);
-- The collision checks scan "the last N valid variants" — newest-first by id.
CREATE INDEX idx_generations_status ON generations(status, id);

-- Salted 8-gram hashes of the competitor corpus (33k posts), populated once
-- by scripts/build-echo-hashes.mjs. The corpus itself stays OUTSIDE the repo
-- and outside this database: hashes only, so the echo check can run without
-- a single byte of third-party text being stored. Empty table = the check
-- passes with a warning (fail-open here is correct: the check guards style
-- similarity, not doctrine; doctrine checks all fail closed).
CREATE TABLE echo_ngrams (
  hash TEXT PRIMARY KEY
) WITHOUT ROWID;

-- The generation job. Priority 5: behind nothing that matters (the poster's
-- 0 slot is parked) and ahead of feed polls — an approved item is the owner
-- waiting on his phone. every_5m not every_1m: generation is not wire-speed,
-- the LLM call is the latency floor anyway, and a 5-minute cadence keeps a
-- misbehaving model from burning budget 60x/hour.
INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('generation', '2026-01-01T00:00:00.000Z', 'every_5m', 1, 5);
