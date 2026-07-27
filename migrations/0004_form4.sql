-- PR-4: Form 4 insider-trades ingester job. Same EDGAR acceptance-window
-- cadence as edgar_8k. Two-phase ingestion introduces items.status
-- 'pending_detail' (stub discovered via feed, awaiting the per-filing
-- ownership-XML fetch). insider_trades.side gains the value 'other' for
-- non-P/S transaction codes (grants, exercises, gifts) kept for the lake.
-- due_at is Date.toISOString() format exactly (see jobs table contract).
INSERT INTO jobs (name, due_at, cadence_profile, enabled)
VALUES ('edgar_form4', '2026-01-01T00:00:00.000Z', 'every_2m_us_0600_2200', 1);

-- Idempotency key for two-phase reprocessing: a trade row is uniquely the
-- (item, position-in-document) pair, so INSERT OR IGNORE makes replays and
-- overlapping invocations harmless.
ALTER TABLE insider_trades ADD COLUMN txn_index INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_insider_trades_item_txn ON insider_trades(item_id, txn_index);
