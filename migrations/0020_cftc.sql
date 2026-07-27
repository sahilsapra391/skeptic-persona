-- P3: CFTC Traders in Financial Futures (weekly Commitments of Traders).
-- Live-verified 2026-07-27T23:23Z: 200, 91 contracts, E-MINI S&P 500 with
-- leveraged funds long 134,932 / short 496,807 on 1.97M open interest.
--
-- CoT publishes Friday 15:30 ET for the prior Tuesday. Hourly is plenty and
-- costs one request; priority 45 alongside the other scheduled prints.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('cftc_cot', '2026-07-27T00:00:00.000Z', 'hourly', 1, 45);
