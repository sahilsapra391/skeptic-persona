-- P3: park the Treasury auction job.
--
-- EVIDENCE (2026-07-27/28), two hosts, two failure modes, 11 consecutive
-- failures, zero successes:
--   www.treasurydirect.gov/TA_WS      -> HTTP 525 (TLS handshake failure)
--   api.fiscaldata.treasury.gov       -> TimeoutError at 147 KB, then ALSO 525
-- Both return 200 in well under a second from a residential connection. The
-- failure is the network path between Cloudflare Worker egress and
-- treasury.gov infrastructure, not our code, our headers or our page size.
--
-- Parked, NOT deleted, on the senate_ptr pattern: a daily probe that
-- auto-recovers if the path improves, so the source comes back on its own
-- without anyone remembering to re-enable it. The real fix is the GitHub
-- Actions lane (residential-class egress) once the Actions quota resets on
-- 2026-08-01, which is the same lane Senate eFD is waiting for.
UPDATE jobs SET cadence_profile = 'daily_1330_utc', due_at = '2026-07-28T13:30:00.000Z'
WHERE name = 'treasury_auction';
