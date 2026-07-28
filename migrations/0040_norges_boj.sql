-- P3: Norges Bank policy rate + Bank of Japan English releases.
-- Live-verified 2026-07-28T04:09Z: Norway key policy rate 4.25% (SDMX CSV,
-- SEMICOLON-delimited); BoJ "What's New" 39 items with JST (+0900) stamps.
--
-- NUMBERING: jumped to 0040 by agreement with the RAG/Threads-strip session,
-- which reserved 0026-0039. Wrangler applies in filename order, so the two
-- workstreams cannot collide on a number.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('rate_norges', '2026-07-28T00:00:00.000Z', 'hourly', 1, 40),
  ('press_boj',   '2026-07-28T00:00:00.000Z', 'hourly', 1, 50);
