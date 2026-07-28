-- P3: SEC Form 25 / 25-NSE (notification of removal from listing).
-- Live-verified 2026-07-28T04:18Z: feed 200 with 14 entries; document is a
-- ~1.1 KB fully typed XML with no prose (Nasdaq removing Churchill Capital
-- Corp IX, 17 CFR 240.12d2-2(a)(1)).
--
-- Closes the story 8-K Item 3.01 opens: 3.01 is the delisting NOTICE, Form 25
-- is the exchange actually striking the security.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('sec_form25', '2026-07-28T00:00:00.000Z', 'every_5m_us_0600_2200', 1, 50);
