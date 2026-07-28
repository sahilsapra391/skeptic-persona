-- P2-R p2r-05: the copy-out card and the manual-posting ledger.
--
-- Publishing is manual: the pipeline's last act is a Telegram card carrying
-- the validated variants, and the owner's last act is telling the card what
-- happened. Without that capture, post_log goes blind — dedup, the nightly
-- Ledger, and the eventual learning loop all lose their ground truth.

-- One card per queue row. The row's absence is the delivery ledger: a send
-- that fails leaves no row, so the next tick retries — same crash-safety
-- shape as the generation lifecycle's terminal-row selection.
CREATE TABLE cards (
  queue_id INTEGER PRIMARY KEY REFERENCES queue(id),
  telegram_message_id INTEGER,
  delivered_at TEXT NOT NULL,
  -- 'commentary' | 'sharp' | 'dry' | 'template' once a Copy button is tapped.
  chosen_variant TEXT,
  -- 'yes' | 'modified' | 'skipped' once the owner answers Posted?.
  posted_state TEXT,
  -- Force-reply prompt ids, same pattern as queue.edit_prompt_message_id.
  posted_prompt_message_id INTEGER,
  edit_prompt_message_id INTEGER,
  updated_at TEXT
);

-- Manual-posting fields. post_log.variant (INTEGER, legacy template slot)
-- stays untouched; the chosen GENERATION variant lives on cards.
ALTER TABLE post_log ADD COLUMN posted_manually INTEGER NOT NULL DEFAULT 0;
ALTER TABLE post_log ADD COLUMN final_text TEXT;
