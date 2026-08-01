-- p4-03: salience curation + digests.
--
-- Items that score below the floor, or that arrive after their category's
-- daily cap, are held back instead of pushed. Two pieces of state:
--
-- 1. items.status = 'digested' — a NEW status value. items.status has no
--    CHECK constraint, and all 15 ingester drain queries filter
--    status = 'new', so this suppresses an item from every drain with zero
--    changes to those queries. It is deliberately NOT 'logged': the lake
--    keeps 'logged' meaning "never met the bar", while 'digested' means
--    "met the bar, lost the slot" — the two must stay distinguishable when
--    we retune, and only 'digested' rows may be promoted back.
--
-- 2. digest_items — the roll-up worklist. One row per held item, carrying
--    the score that held it back, so the weekly composition report can be
--    computed from stored data rather than recomputed from a scorer that
--    may have been retuned since.
--
-- A digest CANNOT live in the queue table: queue.item_id is NOT NULL
-- REFERENCES items(id) with archetype/draft_text NOT NULL, and a sentinel
-- row there would be swept by expirePendingBefore, picked up by
-- runGeneration and deliverCards, and badged by the webhook. Separate table
-- by necessity, not preference.
CREATE TABLE digest_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL UNIQUE REFERENCES items(id),
  archetype TEXT NOT NULL,
  -- Local ET calendar day (YYYY-MM-DD) the item was held on; the digest
  -- sends per (day, archetype).
  day TEXT NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT NOT NULL,             -- 'below_floor' | 'category_cap'
  created_at TEXT NOT NULL,
  -- NULL until the roll-up for its day/archetype has been delivered.
  sent_at TEXT,
  telegram_message_id INTEGER
);
CREATE INDEX idx_digest_pending ON digest_items(day, archetype, sent_at);

-- Daily 21:00 ET roll-up: after the US close and after the post-close EDGAR
-- wave, so a day's digest is complete when it sends. Priority 60 sits below
-- the feed polls (50) and above issuer_refresh (90): a digest is never worth
-- displacing live ingestion.
-- due_at MUST be verbatim Date.toISOString() format: the dispatcher compares
-- it LEXICALLY (0001_init.sql:81-83), and datetime('now') would emit
-- "YYYY-MM-DD HH:MM:SS", which sorts wrong against every other row forever.
INSERT INTO jobs (name, cadence_profile, due_at, enabled, priority)
VALUES ('digest_push', 'daily_2100_et', '2026-01-01T00:00:00.000Z', 1, 60);
