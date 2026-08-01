-- Source health: quarantine endpoints that cannot answer, probe them back.
--
-- Measured in production 2026-08-01, and the numbers are the whole argument:
--
--   name                    job_fails  src_fails  src_last_ok
--   treasury_auction                0         16  never
--   press_cftc_enforcement          0          6  never
--   rate_boe                        0          5  2026-08-01
--   senate_ptr                      0          4  2026-07-28
--
-- Every JOB-level counter reads zero, because the dispatcher only increments
-- it when a handler throws and every polling ingester catches its own fetch
-- error and returns normally. A health check built on the jobs table would
-- have reported the fleet perfectly healthy while two sources had never once
-- succeeded. Health therefore keys off source_state.
--
-- treasury_auction (TLS 525) and press_cftc_enforcement (403) fail from
-- Worker egress and always will; both are covered by the Actions relay. Until
-- quarantined they spend a subrequest and a slice of the tick's time budget
-- every poll against endpoints that have never answered, on a tick already
-- running 68s against a 45s budget.
--
-- rate_boe is why quarantine needs TWO conditions and not just a streak: it
-- carries a failure run most mornings from overnight UK maintenance and
-- answers again by midday. A streak alone would silence a working source.
ALTER TABLE jobs ADD COLUMN quarantined_at TEXT;
ALTER TABLE jobs ADD COLUMN quarantine_reason TEXT;

INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('source_health', '2026-08-01T00:00:00.000Z', 'hourly', 1, 60);
