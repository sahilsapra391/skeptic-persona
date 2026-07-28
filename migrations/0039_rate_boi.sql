-- Bank of Israel interest rate, the first single-observation rate source.
--
-- Live-verified 2026-07-28T06:05Z: GET https://www.boi.org.il/PublicApi/GetInterest
-- returns 112 bytes of exact JSON --
--   {"currentInterest":3.5,"nextInterestDate":"2026-09-01T00:00:00Z",
--    "lastPublishedDate":"2026-07-12T08:59:20.943Z"}
--
-- It carries NO history. detectChange needs two observations, so without the
-- singleObservation capability this source would log forever while looking
-- healthy. The prior is the level WE recorded last poll (source_state.cursor),
-- which we witnessed rather than inferred.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('rate_boi', '2026-07-28T00:00:00.000Z', 'hourly', 1, 40);
