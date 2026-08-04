-- 13F-01: the 13F lane's tables and job row (SKEPTIC-WIRE-13F-LANE-PLAN.md).
-- Scoped freeze exception, owner-granted 2026-08-04: 13F only, driven by the
-- Q2 deadline of 2026-08-14. Additive only.

-- One row per 13F filing, ALL filers. Metadata-lite for the masses (what the
-- current feed itself carries); enriched (period, totals, infotable size) for
-- watchlist CIKs only — mega index managers are low salience by construction
-- and we do not pay per-filing fetches for them.
CREATE TABLE filings_13f (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accession TEXT NOT NULL UNIQUE,
  cik TEXT NOT NULL,
  manager_name TEXT NOT NULL,
  form TEXT NOT NULL,               -- 13F-HR | 13F-HR/A | 13F-NT | 13F-NT/A
  filed_at TEXT NOT NULL,           -- ISO-8601 UTC
  period TEXT,                      -- ISO date, quarter end; watchlist-enriched
  amendment_type TEXT,              -- RESTATEMENT | NEW HOLDINGS (13F-HR/A only)
  infotable_bytes INTEGER,          -- from index.json; watchlist-enriched
  table_value_total INTEGER,        -- filer-declared total, whole USD
  table_entry_total INTEGER,        -- filer-declared row count
  parsed_value_total INTEGER,       -- our summed total, whole USD
  status TEXT NOT NULL DEFAULT 'metadata',
  -- metadata | pending_parse | parsed | parse_failed | deferred_heavy | quarantined | nt_linked
  quarantine_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_filings13f_cik_period ON filings_13f(cik, period);
CREATE INDEX idx_filings13f_status ON filings_13f(status);

-- Aggregated positions per filing, watchlist filers only. Filers report the
-- same security in multiple lots (verified live: MERIDIAN 13F-HR 2026-08-04
-- lists ALPHABET twice, 19,422 sh + 43 sh, separate discretion lots); the
-- desk cares about the position, so lots aggregate at parse on
-- (cusip, put_call). put_call is '' for a straight holding — NULL breaks the
-- PRIMARY KEY (NULL never equals NULL, so dup rows would slip the constraint).
CREATE TABLE holdings_13f (
  filing_id INTEGER NOT NULL REFERENCES filings_13f(id),
  cusip TEXT NOT NULL,
  put_call TEXT NOT NULL DEFAULT '',    -- '' | 'Put' | 'Call'
  issuer TEXT NOT NULL,
  class TEXT,
  value_usd INTEGER NOT NULL,           -- whole dollars (rule eff. 2023-01-03)
  shares INTEGER NOT NULL,
  sh_prn_type TEXT,                     -- SH | PRN ('' when lots disagree)
  discretion TEXT,                      -- SOLE | DFND | OTR | MIXED
  voting_sole INTEGER NOT NULL DEFAULT 0,
  voting_shared INTEGER NOT NULL DEFAULT 0,
  voting_none INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (filing_id, cusip, put_call)
);

-- The watchlist. Seeded in 13F-02 AFTER the owner signs the candidate list —
-- created empty here so the parse path is buildable and no-ops until then.
-- coverage_start is the coverage-guard anchor: diff claims are licensed only
-- against periods on or after it (a first-poll backfill is not observation).
CREATE TABLE managers_13f (
  cik TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,                -- 1 = individual cards, 2 = digest only
  added_at TEXT NOT NULL,
  coverage_start TEXT
);

-- CUSIP -> ticker/name cache, filled by 13F-02 (openFIGI, fail-open to issuer
-- name). Created now so holdings queries can LEFT JOIN it from day one.
CREATE TABLE cusip_map (
  cusip TEXT PRIMARY KEY,
  ticker TEXT,
  name TEXT,
  source TEXT NOT NULL,                 -- openfigi | fallback
  resolved_at TEXT NOT NULL
);

-- Poll job. every_30m: 13F is a quarterly event lane and the current feed is
-- a rolling window; 48 polls/day x up to 3 pages x 100 entries comfortably
-- clears the ~5k-filings deadline-day flood. Priority 60: nothing here is
-- latency-critical (the form reports a quarter-old photo by law).
INSERT INTO jobs (name, due_at, cadence_profile, enabled, priority)
VALUES ('edgar_13f', '2026-01-01T00:00:00.000Z', 'every_30m', 1, 60);
