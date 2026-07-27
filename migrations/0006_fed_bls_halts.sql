-- PR-6 (final P1 chunk): Fed press RSS, trading halts (both feeds share
-- items.source 'halt' with a normalized key for cross-feed dedup), and the
-- BLS release-second watcher (armed from bls.ics into release_calendar;
-- bls_watch's every_30m is only the fallback heartbeat — the calendar sync
-- re-points its due_at at scheduled-release-minus-90s).
-- Also: senate_ptr drops to a daily probe — efdsearch.senate.gov 403s
-- Cloudflare egress outright (verified in prod 2026-07-27, incl. with
-- browser-grade headers: IP-class block). It auto-recovers if unblocked;
-- the Actions lane takes over Senate polling after Aug 1.
-- due_at is Date.toISOString() format exactly (see jobs table contract).
INSERT INTO jobs (name, due_at, cadence_profile, enabled) VALUES
  ('fed_press', '2026-01-01T00:00:00.000Z', 'every_5m_us_0600_2200', 1),
  ('halts_nasdaq', '2026-01-01T00:00:00.000Z', 'every_1m_us_0400_2000', 1),
  ('halts_nyse', '2026-01-01T00:00:00.000Z', 'every_5m_us_0600_2200', 1),
  ('bls_calendar', '2026-01-01T00:00:00.000Z', 'daily_1330_utc', 1),
  ('bls_watch', '2026-01-01T00:00:00.000Z', 'every_30m', 1);

UPDATE jobs SET cadence_profile = 'daily_1330_utc' WHERE name = 'senate_ptr';
