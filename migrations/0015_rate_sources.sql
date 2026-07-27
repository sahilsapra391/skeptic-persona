-- P3: central bank policy rates (Canada, Sweden, Brazil, South Africa,
-- Switzerland). All five endpoints live-verified 2026-07-27T22:30Z.
--
-- Hourly: policy rates change a handful of times a year on scheduled dates,
-- so this is about being timely on decision day, not about polling pressure.
-- Priority 40 puts them ahead of the high-volume filing ingesters, since a
-- rate decision is the most time-sensitive thing on the wire after a halt.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('rate_boc',       '2026-07-27T00:00:00.000Z', 'hourly', 1, 40),
  ('rate_riksbank',  '2026-07-27T00:00:00.000Z', 'hourly', 1, 40),
  ('rate_bcb',       '2026-07-27T00:00:00.000Z', 'hourly', 1, 40),
  ('rate_sarb',      '2026-07-27T00:00:00.000Z', 'hourly', 1, 40),
  ('rate_snb',       '2026-07-27T00:00:00.000Z', 'hourly', 1, 40);
