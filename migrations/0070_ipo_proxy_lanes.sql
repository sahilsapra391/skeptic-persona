-- p5-30 (IPO / S-1) and p5-31 (proxy contest), both DISCOVERY for now.
--
-- Neither has an archetype or an exemplar bank yet, and the exemplar gate
-- refuses generation outright when a bank is empty. Scoring these postable
-- before the archetype exists would produce a template card with no voice —
-- the exact defect B-07/B-08 removed, where four cards sat at
-- skipped_no_exemplar for weeks. So both ingest at log-only and the archetypes
-- are the follow-on chunk that turns carding on.
--
-- ORDERING (D-43): this migration goes in AFTER the deploy carrying
-- src/ingesters/s1Ipo.ts and src/ingesters/proxyContest.ts. A job row whose
-- handler is not yet deployed gets claimed by the dispatcher, finds nothing,
-- and burns the slot.
--
-- Columns read from 0001_init.sql, not guessed: (name, due_at,
-- cadence_profile, enabled, priority). due_at must be the fixed-width
-- Date.toISOString() form, because the dispatcher compares it LEXICALLY.
--
-- CADENCE. S-1 is the busier feed (31 entries when measured) and registration
-- statements arrive through the business day, so every_30m. Contested proxy
-- filings are genuinely rare (DEFC14A and PREC14A returned ONE entry each), so
-- hourly is ample and a faster poll would mostly re-read the same three rows.
INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('sec_s1', '2026-01-01T00:00:00.000Z', 'every_30m', 1, 70);

INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('sec_proxy_contest', '2026-01-01T00:00:00.000Z', 'hourly', 1, 70);
