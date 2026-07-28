-- P3: enforcement wire (SEC administrative proceedings, CFTC enforcement,
-- FTC competition). All three live-verified 2026-07-28T04:02Z.
--
-- DEAD URL RECORDED: the SEC litigation-releases feed at
-- /rss/litigation/litreleases.xml returns 404 with an HTML body. The
-- administrative-proceedings feed at /rss/litigation/admin.xml is live with
-- 25 items.
--
-- Enforcement is the highest-lift category measured across the competitor
-- corpora (1.63x). Hourly is ample: these publish in business-hours batches.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('press_sec_enforcement',  '2026-07-28T00:00:00.000Z', 'hourly', 1, 45),
  ('press_cftc_enforcement', '2026-07-28T00:00:00.000Z', 'hourly', 1, 45),
  ('press_ftc_competition',  '2026-07-28T00:00:00.000Z', 'hourly', 1, 45);
