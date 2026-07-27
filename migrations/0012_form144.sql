-- P2: SEC Form 144 (notice of proposed insider sale).
-- Live-verified 2026-07-27T20:35Z: feed 200 (10 entries), documents 200.
-- Same cadence as Form 4 (~104 filings/day); priority 50 like other ingesters.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('sec_form144', '2026-07-27T00:00:00.000Z', 'every_5m_us_0600_2200', 1, 50);
