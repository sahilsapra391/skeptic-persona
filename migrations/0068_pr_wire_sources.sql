-- p5-21: GlobeNewswire and PR Newswire as DISCOVERY sources.
--
-- These items never become a post. Non-negotiable #3 bans vendor-data
-- republishing and these are vendors; the p4 mesh rules (owner-set) say news
-- items are "DISCOVERY, never citation" and that the PRIMARY document gets
-- fetched and queued with its own attribution. So a wire row is a signal that
-- something happened, recorded at log-only score, and the desk publishes the
-- company's own filing instead.
--
-- hourly, not every_30m: these are a corroboration signal rather than a
-- latency-critical feed, and the lane that actually cards (edgar_8k) already
-- polls faster than any wire relays it.
--
-- ORDERING (D-43): this migration goes in AFTER the deploy carrying the
-- handlers, because a job row registered before its handler is claimed by the
-- dispatcher and has its due_at advanced by a full cadence.

INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('wire_globenewswire', '2026-01-01T00:00:00.000Z', 'hourly', 1, 70);

INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('wire_prnewswire', '2026-01-01T00:00:00.000Z', 'hourly', 1, 70);
