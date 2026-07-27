-- P3: US Treasury auction results (TreasuryDirect TA_WS).
-- Live-verified 2026-07-27T22:42Z: 200, 5 auctions, same-day results
-- (2-Year Note bid-to-cover 2.66, high yield 4.315%).
--
-- Priority 40 alongside the rate sources: an auction result is a scheduled
-- print and stale within the hour. every_30m rather than hourly so a result
-- posted just after 11:30 ET is not half an hour old before we see it.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('treasury_auction', '2026-07-27T00:00:00.000Z', 'every_30m', 1, 40);
