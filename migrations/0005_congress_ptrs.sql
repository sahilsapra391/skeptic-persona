-- PR-5: congressional PTR ingesters.
-- senate_ptr: intra-day JSON endpoint behind the session handshake (hourly).
-- house_ptr: bulk index ZIP, rebuilt ~once/weekday ~13:00 UTC (hourly
-- conditional GET; 304s cost one request). House items are discovery-level
-- (lake-only) until the Actions daily job adds PDF transaction extraction.
-- due_at is Date.toISOString() format exactly (see jobs table contract).
INSERT INTO jobs (name, due_at, cadence_profile, enabled) VALUES
  ('senate_ptr', '2026-01-01T00:00:00.000Z', 'hourly', 1),
  ('house_ptr', '2026-01-01T00:00:00.000Z', 'hourly', 1);
