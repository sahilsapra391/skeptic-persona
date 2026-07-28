-- P3: EDGAR daily-index reconciliation.
--
-- An AUDIT, not a post source. Every EDGAR poller reads `getcurrent`, a
-- rolling window; if a form type spikes or a form-type string is subtly
-- wrong, filings vanish with no error anywhere. That is exactly how the
-- SCHEDULE 13D naming bug hid.
--
-- Verified 2026-07-28T04:14Z on the 2026-07-27 index (798 KB): Form 4 588,
-- SCHEDULE 13G 432, 13F-HR 297, 8-K 226, Form 144 166. Our Schedule 13
-- ingester polls 40 entries per feed, so this will immediately quantify how
-- much of a 432-filing day we actually capture.
--
-- Daily at 13:30 UTC (09:30 ET): the prior day's index is complete by then.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('edgar_reconcile', '2026-07-28T13:30:00.000Z', 'daily_1330_utc', 1, 60);
