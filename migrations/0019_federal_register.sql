-- P3: Federal Register presidential documents (EOs, proclamations,
-- determinations). Live-verified 2026-07-27T22:52Z: 200, 6,763 documents,
-- newest page carried three tariff proclamations plus one executive order.
-- Tariffs are imposed by proclamation, which makes this the primary source
-- for the highest-volume beat in the competitor set.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('federal_register', '2026-07-27T00:00:00.000Z', 'hourly', 1, 45);
