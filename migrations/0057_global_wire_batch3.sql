-- Global wire fanout, batch 3: six more sources.
--
-- 42 candidates probed 2026-08-01. Twelve returned 200 with three or more
-- items; ALL TWELVE then parsed cleanly through our own parser on the first
-- attempt, where batch 1 had four of eight parse to zero. That difference is
-- the batch-1 dialect work (RSS 1.0/RDF, Atom, CDATA anywhere, four date
-- fields) paying for itself, not the batch-3 feeds being better behaved.
--
-- Of the twelve, THREE WERE ALREADY REGISTERED under the same URL:
-- press_ftc_competition, press_fca, press_eu_commission. The probe list had
-- no guard against sources we already poll. A test now asserts no two
-- PRESS_SOURCES share a URL, so the next such duplicate fails CI instead of
-- being caught by eye.
--
-- Two returned usable feeds and were rejected on editorial grounds, both
-- recorded in docs/verification/2026-08-01-global-wire-batch1.md:
--   CBO  -- 12 of 12 recent items are cost estimates for minor bills. The
--           macro publications exist but need an allowlist, not a blocklist.
--   DOL  -- grant awards, single-restaurant back-wage recoveries, OSHA
--           citations. The one recurring item worth having, the Unemployment
--           Insurance Weekly Claims Report, carries its numbers in a data
--           file rather than the title, so it wants its own ingester.
--
-- Cadence: hourly, matching batches 1 and 2. BEA is the exception worth
-- noting -- GDP and PCE land on a published schedule, so an hourly poll can
-- sit up to an hour behind a release the desk cares about. Left hourly here
-- because release-time scheduling belongs to the cadence work, not to a
-- source-registration migration.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('press_bea',   '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_eia',   '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_wto',   '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_cma',   '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_hmt',   '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_finma', '2026-08-02T00:00:00.000Z', 'hourly', 1, 50);
