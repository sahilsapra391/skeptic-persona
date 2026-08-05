-- 13F-03: the diff engine's output table. Additive.
--
-- Keyed by (cik, period, cusip, put_call), NOT by filing_id: a diff belongs
-- to the period-pair, and an amendment that replaces a period's snapshot
-- (RESTATEMENT) recomputes the SAME logical diff — delete + reinsert for the
-- (cik, period), and for the next period whose prev this period was.
--
-- Every figure the model could want is PRE-COMPUTED here (the model never
-- does arithmetic — doctrine). EXIT rows carry the prior values; NEW rows
-- have prev_* NULL and qoq_share_delta_pct NULL (delta over zero is not a
-- number, and NULL must never render as one).
CREATE TABLE diffs_13f (
  cik TEXT NOT NULL,
  period TEXT NOT NULL,               -- ISO date, the CURRENT quarter end
  prev_period TEXT NOT NULL,          -- ISO date the diff is computed against
  cusip TEXT NOT NULL,
  put_call TEXT NOT NULL DEFAULT '',
  issuer TEXT NOT NULL,
  status TEXT NOT NULL,               -- NEW | EXIT | ADD | TRIM | UNCHANGED
  value_usd INTEGER,                  -- current value (NULL on EXIT)
  shares INTEGER,                     -- current shares (NULL on EXIT)
  prev_value_usd INTEGER,             -- NULL on NEW
  prev_shares INTEGER,                -- NULL on NEW
  pct_of_portfolio REAL,              -- value / period total * 100 (NULL on EXIT)
  qoq_share_delta INTEGER,            -- shares - prev_shares (signed)
  qoq_share_delta_pct REAL,           -- NULL on NEW (no base)
  qoq_value_delta_usd INTEGER,        -- signed; EXIT = -prev_value_usd
  computed_at TEXT NOT NULL,
  PRIMARY KEY (cik, period, cusip, put_call)
);
CREATE INDEX idx_diffs13f_cik_period ON diffs_13f(cik, period);
CREATE INDEX idx_diffs13f_status ON diffs_13f(cik, period, status);
