-- D-28, closed: the 13F lane fills filings_13f, holdings_13f and diffs_13f
-- and has never once written to `items`, so 696 filings have produced zero
-- cards. This registers the job that turns a parsed tier-1 filing into one.
--
-- every_30m, matching `edgar_13f` that feeds it: nothing in this lane is
-- latency-critical (the form reports a quarter-old photo by law) and the job
-- makes NO external fetches, so a short cadence costs D1 reads and nothing
-- else. Priority 60, same as its feeder.
--
-- The job is bounded at CARDS_PER_RUN per tick. The Aug-14 deadline puts
-- hundreds of filings in the table on one day, and a job that carded them all
-- in one pass would blow both the D1 budget and the owner's attention. At 48
-- ticks a day that is up to 144 cards/day of headroom against a lane whose
-- tier-1 watchlist is 15 managers.

-- ORDERING, learned the hard way on this very migration (D-43). A job row
-- inserted BEFORE its handler is deployed gets claimed by the dispatcher,
-- hits the "no handler registered" branch, and has its due_at advanced by a
-- full cadence — silently burning one slot. The signature is jobs.last_ok_at
-- NULL while jobs.due_at has moved.
--
-- So: schema migrations go in before merge, JOB REGISTRATION goes in after
-- the deploy that carries its handler. every_30m made this cost 30 minutes;
-- on a daily_* cadence it would have cost a day.
INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('edgar_13f_breakdown', '2026-01-01T00:00:00.000Z', 'every_30m', 1, 60);
