-- P2 PR-8 (paid tier): job priority + per-job health.
--
-- WHY PRIORITY: with the source expansion the job count goes from ~10 to
-- 30-40. Pure due_at ordering means a release-second watcher due at exactly T
-- queues behind stale backlog, which destroys the whole point of the
-- scheduled-print archetype. Lower number = runs first.
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;

-- Per-job health, so a dead job is visible without reading logs. source_state
-- tracks SOURCE reachability; this tracks whether the JOB itself is running.
ALTER TABLE jobs ADD COLUMN last_ok_at TEXT;
ALTER TABLE jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_jobs_due;
CREATE INDEX idx_jobs_due ON jobs(enabled, priority, due_at);

-- The poster must never be starved by ingester backlog: an approved draft
-- waiting on a queue of 40 feed polls is the one failure the owner sees.
UPDATE jobs SET priority = 0 WHERE name = 'poster';
-- Release-second watchers pre-empt everything except posting.
UPDATE jobs SET priority = 10 WHERE name IN ('bls_watch', 'bls_calendar');
-- Token refresh is cheap and load-bearing (a dead token stops all posting).
UPDATE jobs SET priority = 20 WHERE name = 'threads_token_refresh';
