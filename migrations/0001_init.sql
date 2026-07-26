-- Skeptic Wire schema v1. All timestamps are ISO-8601 UTC strings.
-- Dedup lives HERE (not KV): items.dedup_key UNIQUE + INSERT OR IGNORE.

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,     -- '<source>:<external_id>'
  source TEXT NOT NULL,               -- edgar_8k | edgar_form4 | insider_cluster | house_ptr | senate_ptr | fed_press | bls | halt
  external_id TEXT NOT NULL,          -- accession no / DocID / guid / halt key / release id
  category TEXT NOT NULL,             -- taxonomy bucket: filing | insider | congress | macro_print | fed | halt
  event_at TEXT,                      -- when the underlying event happened (acceptance/halt/release time)
  fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL,           -- the link every post must carry
  payload TEXT NOT NULL,              -- JSON of parsed structured fields ONLY
  score INTEGER NOT NULL DEFAULT 0,   -- 0 ignore | 1 log-only | 2 postable | 3 auto-alert grade
  status TEXT NOT NULL DEFAULT 'new'  -- new | queued | approved | rejected | expired | posted
);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_source_event ON items(source, event_at);

-- One row per Form 4 transaction line; feeds cluster detection (PR-4).
CREATE TABLE insider_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  issuer_cik TEXT NOT NULL,
  ticker TEXT,
  insider_cik TEXT NOT NULL,
  insider_name TEXT NOT NULL,
  is_officer INTEGER NOT NULL DEFAULT 0,
  is_director INTEGER NOT NULL DEFAULT 0,
  officer_title TEXT,
  side TEXT NOT NULL,                 -- buy | sell
  code TEXT NOT NULL,                 -- raw transactionCode (P, S, A, ...)
  shares REAL,
  price REAL,
  shares_after REAL,
  pct_change REAL,                    -- NULL when not derivable from the document
  transaction_date TEXT NOT NULL,
  is_amendment INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_insider_cluster ON insider_trades(issuer_cik, side, transaction_date);

-- Telegram approval state machine (PR-2).
CREATE TABLE queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  archetype TEXT NOT NULL,            -- WIRE | GLOBAL_WIRE | FILING_ALERT | ...
  draft_text TEXT NOT NULL,
  telegram_message_id INTEGER,
  state TEXT NOT NULL DEFAULT 'pending', -- pending | approved | edited | rejected | expired
  edited_text TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_queue_state ON queue(state);

-- Posted-output ledger: budget accounting + evergreen re-share tracking (P2+).
CREATE TABLE post_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER REFERENCES queue(id),
  platform_post_id TEXT,              -- Threads media id
  posted_at TEXT NOT NULL,
  archetype TEXT NOT NULL,
  variant INTEGER,
  category TEXT NOT NULL
);

-- Per-source polling cursor + health. Replaces most planned KV usage.
CREATE TABLE source_state (
  source TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  cursor TEXT,                        -- source-specific watermark (accession, USDL number, snapshot hash)
  last_polled_at TEXT,
  last_ok_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Internal due-scheduler behind the single cron trigger.
CREATE TABLE jobs (
  name TEXT PRIMARY KEY,
  -- Exactly Date.toISOString() format: "YYYY-MM-DDTHH:MM:SS.sssZ".
  -- The dispatcher compares due_at lexically, which is only correct for this
  -- fixed-width UTC format — seed migrations must use it verbatim.
  due_at TEXT NOT NULL,
  cadence_profile TEXT NOT NULL,      -- see src/cadence.ts
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Scheduled-release calendar (BLS first, PR-6; RBI/ECB later reuse this).
CREATE TABLE release_calendar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  release_name TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,         -- UTC, DST-correctly converted from source-local time
  armed INTEGER NOT NULL DEFAULT 0,
  fired_at TEXT,
  UNIQUE(source, release_name, scheduled_at)
);
