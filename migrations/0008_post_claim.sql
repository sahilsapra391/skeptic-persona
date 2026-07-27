-- P2 PR-7 hardening: make publishing crash-safe.
-- The poster PRE-CLAIMS a queue row in post_log (platform_post_id NULL)
-- BEFORE calling Threads, then fills in the id after. If the isolate dies
-- between publish and commit, the claim row still excludes the row from the
-- next run's selection — a public post can never be published twice. The
-- UNIQUE index makes the claim atomic (INSERT OR IGNORE races resolve to
-- exactly one winner).
CREATE UNIQUE INDEX idx_post_log_queue ON post_log(queue_id);
