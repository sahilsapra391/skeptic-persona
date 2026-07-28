-- P3: Nasdaq Reg SHO threshold securities list.
-- Live-verified 2026-07-28T04:18Z: 200, 2,485 bytes, pipe-delimited.
--
-- A security appears only after FIVE consecutive settlement days with
-- fails-to-deliver at 0.5%+ of shares outstanding, so both entry and exit are
-- filed signals of persistent settlement failure. Zero coverage in the
-- 19,518-post competitor corpus.
--
-- Daily: the file is published once per settlement day.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('regsho_threshold', '2026-07-28T13:30:00.000Z', 'daily_1330_utc', 1, 50);
