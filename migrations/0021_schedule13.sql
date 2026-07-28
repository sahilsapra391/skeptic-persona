-- P3: SEC Schedule 13D / 13G (beneficial ownership above 5%).
-- Live-verified 2026-07-28T01:03Z: type=SCHEDULE+13D returns 40 entries;
-- the obvious spelling type=SC+13D returns ONE. Cover-page fields confirmed
-- on accession 0001493152-26-034889 (Haggai Alon, 18.5% of SMX).
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('sec_schedule13', '2026-07-28T00:00:00.000Z', 'every_5m_us_0600_2200', 1, 50);
