-- Reserve Bank of Australia cash rate target.
--
-- Live-verified 2026-07-28T05:50Z against the RBA's own F1 statistical table:
-- Cash Rate Target 4.35%, last changed 06-May-2026 from 4.10% (+25bp). The
-- file is 304KB of daily rows back to 2011 and serves Last-Modified.
--
-- First Asia-Pacific policy rate in the set; the other eight are European,
-- North American, South American and African.
--
-- Numbering: 0026-0030 are reserved for the RAG session (0027 is now applied);
-- ingestion work continues from 0031.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('rate_rba', '2026-07-28T00:00:00.000Z', 'hourly', 1, 40);
