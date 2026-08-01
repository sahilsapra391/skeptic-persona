-- P4-09: the VOICE bank, as a D1 table.
--
-- Scope note: the plan originally paired this with an Upstash VOICE namespace
-- for similarity retrieval. That was a sequencing error — the learning loop
-- needs only D1 and the capture that already ships, and with zero manual
-- posts recorded there is nothing to retrieve against. The namespace waits
-- for post volume; the loop starts collecting now, because it cannot report
-- on days that happened before it existed.
--
-- What earns a row: the owner published it. That is the only quality signal
-- available and it is a strong one. Both outcomes are promoted, and the
-- EDITED ones are the more valuable of the two — a rewrite is the owner
-- telling us, in his own words, what the draft should have said.
CREATE TABLE voice_finals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- One promotion per post. Re-answering a card repairs the row rather than
  -- appending a second one (same idempotence shape as the post_log claim).
  queue_id INTEGER NOT NULL UNIQUE REFERENCES queue(id),
  archetype TEXT NOT NULL,
  -- 'commentary' | 'wire' — matches OwnerExemplar.register so promoted rows
  -- and the committed bank are the same shape at the injection point.
  register TEXT NOT NULL,
  -- The owner-approved text, verbatim. This is the only table whose text is
  -- allowed to reach a prompt as an exemplar.
  text TEXT NOT NULL,
  -- 0 = shipped exactly as generated, 1 = the owner rewrote it.
  was_edited INTEGER NOT NULL,
  promoted_at TEXT NOT NULL
);

-- Retrieval is always per archetype, newest first.
CREATE INDEX idx_voice_finals_archetype ON voice_finals(archetype, promoted_at DESC);

-- The nightly report. 13:30 UTC = 09:30 ET, before the filing window opens,
-- so the number lands with yesterday complete rather than today half-done.
INSERT INTO jobs (name, due_at, cadence_profile, enabled)
VALUES ('voice_digest', '2026-08-02T13:30:00.000Z', 'daily_1330_utc', 1);
