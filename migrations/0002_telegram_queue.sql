-- PR-2: Telegram approval queue support.

-- The Edit flow: the bot sends a force-reply prompt and remembers its
-- message id here; the owner's reply to that exact message carries the
-- corrected text.
ALTER TABLE queue ADD COLUMN edit_prompt_message_id INTEGER;

-- Telegram retries webhook deliveries on any non-2xx; dedupe on update_id
-- EQUALITY (ids can reset after a week of silence — never rely on
-- monotonicity). Purged after 7 days by the queue_expiry job.
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- Pending queue entries expire after QUEUE_TTL (checked by the queue_expiry
-- job) so stale drafts never post hours after the fact. Wire-speed content
-- is worthless late.
-- due_at is Date.toISOString() format exactly (see jobs table contract).
INSERT INTO jobs (name, due_at, cadence_profile, enabled)
VALUES ('queue_expiry', '2026-01-01T00:00:00.000Z', 'every_30m', 1);
