-- Global wire fanout, batch 1: eight sources, live-probed before adoption.
--
-- NUMBERED 0056, not 0049: the RAG session was allocated 0049-0055 after I
-- had already written this file. Neither was applied, so the free one moves.
-- Recorded because a chunk-number collision earlier tonight cost a branch
-- rename, and this is the same failure in the namespace where it would have
-- cost a production migration instead.
--
-- Twenty candidates were fetched with a declared UA on 2026-08-01T22:4xZ and
-- kept only if they returned 200 AND parsed to three or more items through
-- our OWN parser, not merely through curl. Eleven failed and are recorded in
-- docs/verification/2026-08-01-global-wire-batch1.md so nobody re-probes them.
--
-- US:      press_doj, press_fed_speeches
-- Europe:  press_ecb, press_ons, press_ofsi
-- Other:   press_boc, press_rbi, press_sebi
--
-- RBI and SEBI are the desk's first coverage of India at all. NSE and BSE
-- stay parked: both hosts reset our declared UA (verified 2026-07-27), and
-- doctrine #4 forbids disguising the client to get around it.
--
-- Cadence: hourly. These are press wires, not market data, and every one of
-- them serves conditional-request validators, so a quiet hour costs one 304.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('press_doj',          '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_fed_speeches', '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_ecb',          '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_boc',          '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_ons',          '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_ofsi',         '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_rbi',          '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_sebi',         '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  -- Batch 2, probed in the same pass: 24 more candidates, 8 returned usable
  -- feeds, 6 survived parsing. GDELT is REJECTED ON DOCTRINE, not deferred:
  -- it is a news aggregator, so its payload is other outlets' coverage
  -- ("reportedly", twice over), which non-negotiable #2 forbids outright.
  ('press_sec_speeches', '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_cfpb',         '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_gao',          '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_eba',          '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_boe_news',     '2026-08-02T00:00:00.000Z', 'hourly', 1, 50),
  ('press_riksbank',     '2026-08-02T00:00:00.000Z', 'hourly', 1, 50);
