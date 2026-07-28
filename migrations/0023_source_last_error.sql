-- P3: persist the last failure per source.
--
-- WHY: diagnosing a failing ingester currently requires `wrangler tail`,
-- which must be running at the exact moment a job fires. Chasing the Treasury
-- 525 tonight took four timed tail attempts, three of which captured nothing,
-- because a 30-minute cadence gives a ~2-second window. The error text is the
-- single most valuable field for triage and it was the one thing not stored.
ALTER TABLE source_state ADD COLUMN last_error TEXT;
ALTER TABLE source_state ADD COLUMN last_error_at TEXT;
