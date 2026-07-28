-- P3: Norges Bank policy rate + Bank of Japan English releases.
-- Live-verified 2026-07-28T04:09Z: Norway key policy rate 4.25% (SDMX CSV,
-- SEMICOLON-delimited); BoJ "What's New" 39 items with JST (+0900) stamps.
--
-- NUMBERING: the RAG session reserved 0026-0030 (it expects 2-3 migrations:
-- park-threads, post_log manual-posting columns, a generation audit table),
-- so ingestion work starts at 0031. Agreed by direct message; wrangler
-- applies in filename order, so the two workstreams cannot collide.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('rate_norges', '2026-07-28T00:00:00.000Z', 'hourly', 1, 40),
  ('press_boj',   '2026-07-28T00:00:00.000Z', 'hourly', 1, 50);
