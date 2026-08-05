-- Undelivered approval cards get retried instead of being lost silently.
--
-- WHAT HAPPENED. enqueueForApproval writes the queue row, then sends the
-- Telegram notification. If the send fails the row survives with
-- telegram_message_id NULL and the comment in enqueue.ts says the quiet part
-- out loud: "Queue row survives; the expiry job will sweep it if nobody
-- notices." Nobody noticed. On 2026-08-05 a hung pacing promise (see
-- 0064's sibling fix in lib/telegram.ts) stranded ten hours of cards; every
-- one was created, none was delivered, no job reported unhealthy, and the
-- cards simply aged out at TTL unseen.
--
-- The pacing bug is fixed at its root. This column exists because that is not
-- the only way a send can fail: Telegram can 429, 5xx, or go down entirely,
-- and any of those must degrade to "delivered late" rather than "lost".
--
-- WHY A COUNTER AND NOT A BOOLEAN. Retrying forever against a permanently
-- rejected message (a card whose text Telegram will never accept) would spend
-- the whole notify budget on one row every tick and starve every fresh card
-- behind it. The counter is what makes the retry bounded, and it is also the
-- signal that says "this row is not coming back", which the health report can
-- read.
--
-- DEFAULT 0 on existing rows is correct rather than convenient: none of them
-- has been retried, and the seven rows stranded on 2026-08-05 become eligible
-- immediately, which is the intended recovery.
ALTER TABLE queue ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;

-- Partial index: the retry query asks for pending rows that never got a
-- message id, which is a tiny slice of a table dominated by expired rows.
CREATE INDEX IF NOT EXISTS idx_queue_undelivered
  ON queue(state, telegram_message_id, notify_attempts);

-- every_5m, not every_30m. A missed approval card is time-critical content the
-- owner is waiting on; the generation lane already runs at this cadence and
-- the retry does nothing at all when the queue is clean.
INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('notify_retry', '2026-01-01T00:00:00.000Z', 'every_5m', 1, 25);
