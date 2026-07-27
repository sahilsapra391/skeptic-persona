-- P3: Bank of England Bank Rate and ECB main refinancing rate.
-- Live-verified 2026-07-27T22:42Z: BoE 3.75% (24 Jul), ECB 2.4% (27 Jul).
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('rate_boe', '2026-07-27T00:00:00.000Z', 'hourly', 1, 40),
  ('rate_ecb', '2026-07-27T00:00:00.000Z', 'hourly', 1, 40);
