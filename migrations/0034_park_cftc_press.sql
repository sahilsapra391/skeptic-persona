-- P3: park the CFTC enforcement press feed.
--
-- EVIDENCE 2026-07-28T04:08Z: www.cftc.gov/RSS/RSSENF/rssenf.xml returns
-- HTTP 403 to Cloudflare Worker egress and HTTP 200 to the identical
-- declared UA from a residential connection. SEC and FTC were polled in the
-- same tick from the same Worker and both returned 200, so this is
-- host-specific rather than an issue with our client.
--
-- NOTE: CFTC positioning (Commitments of Traders) is UNAFFECTED — it lives
-- on publicreporting.cftc.gov, a different host that answers Workers fine.
-- Only the www.cftc.gov press host blocks us.
--
-- Fifth egress failure mode on this project: Senate eFD 403s datacenter IPs,
-- NSE India resets on declared UA, treasury.gov fails TLS and times out, and
-- now www.cftc.gov 403s. Parked on the daily auto-recovering probe so it
-- returns on its own if the block lifts; the durable fix is the GitHub
-- Actions lane after 2026-08-01.
UPDATE jobs SET cadence_profile = 'daily_1330_utc', due_at = '2026-07-28T13:30:00.000Z'
WHERE name = 'press_cftc_enforcement';
