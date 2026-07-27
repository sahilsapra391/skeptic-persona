-- P2 PR-7: the Threads poster (drains approved queue entries; gated by
-- POSTING_ENABLED and the editorial daily cap) and the load-bearing weekly
-- token refresh (long-lived tokens die at 60 days; expired = manual OAuth).
-- due_at is Date.toISOString() format exactly (see jobs table contract).
INSERT INTO jobs (name, due_at, cadence_profile, enabled) VALUES
  ('poster', '2026-01-01T00:00:00.000Z', 'every_5m', 1),
  ('threads_token_refresh', '2026-01-01T00:00:00.000Z', 'daily_1330_utc', 1);
