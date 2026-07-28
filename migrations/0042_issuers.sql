-- Issuer reference table: which EDGAR filers are tradeable companies.
--
-- EDGAR's filer universe is hundreds of thousands of CIKs, most of them funds,
-- trusts, shells and non-traded vehicles. Measured against 447 live 8-K items
-- on 2026-07-28: 17% came from filers with NO listing at all (BlackRock
-- Private Credit Fund, KKR Infrastructure Conglomerate, Golub Capital Private
-- Credit Fund) and another 29% from issuers under $300M of public float.
--
-- Both fields are the companies' OWN, filed with the SEC: exchange from SEC's
-- published ticker file, float from dei:EntityPublicFloat on each
-- registrant's annual-report cover page. No vendor data.
CREATE TABLE IF NOT EXISTS issuers (
  cik INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL DEFAULT '',
  -- '' means present in SEC's file but carrying no exchange.
  exchange TEXT NOT NULL DEFAULT '',
  -- NULL means UNKNOWN, never zero. A pre-IPO measurement date reports 0 and
  -- a non-December fiscal year can fall outside the frames we union, so the
  -- gate must not read absence as "small".
  public_float INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issuers_exchange ON issuers(exchange);

-- Weekly is enough: listings and floats move slowly, and the fetch is ~1.2MB
-- across the ticker file and five XBRL frames.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('issuer_refresh', '2026-07-28T00:00:00.000Z', 'daily_1330_utc', 1, 90);
