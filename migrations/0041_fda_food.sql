-- openFDA food enforcement reports.
--
-- Live-verified 2026-07-28: api.fda.gov/food/enforcement.json returns 200
-- with 29,264 records and the IDENTICAL field shape as drug enforcement, so
-- one parser and one grouper cover both.
--
-- CLASS I ONLY reaches the approval queue (declared in FDA_SOURCES, not here).
-- Measured over a 61-day window: 123 grouped events, of which Class I is
-- ~17.7/month and Class II ~33/month. Class II food is mostly undeclared
-- allergens at regional producers -- a real public-health notice, but not
-- market intelligence, and the queue currently expires more cards than it
-- approves. Class II and III still land in the lake.
--
-- Twice daily, matching the drug job: openFDA rate-limits per IP and
-- Cloudflare egress IPs are shared.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('fda_food_recall', '2026-07-28T00:00:00.000Z', 'hourly', 1, 55);
