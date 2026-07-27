-- P3: FDA drug enforcement reports (recalls).
-- Live-verified 2026-07-27T22:49Z: 200, flat typed records newest-first.
--
-- every_30m would be pointless (FDA publishes in daily batches) and openFDA
-- rate-limits per IP on egress addresses SHARED with every other Cloudflare
-- Worker. Twice-daily keeps us well clear while still same-day.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('fda_drug_recall', '2026-07-27T00:00:00.000Z', 'daily_1330_utc', 1, 45);
