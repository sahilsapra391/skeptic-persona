-- P3: NOAA National Hurricane Center active storms.
-- Live-verified 2026-07-28T04:58Z: 200, two active storms (Hurricane
-- Genevieve 125 kt / 939 mb, TS Fausto 60 kt) — both eastern Pacific, and
-- both correctly produced nothing under the Atlantic-only gate.
--
-- Hourly during the season; advisories update roughly every 6 hours, so this
-- is about catching an intensity change promptly rather than polling hard.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('noaa_storms', '2026-07-28T00:00:00.000Z', 'hourly', 1, 55);
