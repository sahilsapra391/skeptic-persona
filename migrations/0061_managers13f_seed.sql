-- 13F-02: the watchlist, signed by the owner 2026-08-04 as proposed.
-- Every CIK below was pulled LIVE from EDGAR on 2026-08-04 (never memory) and
-- verified to be the ACTIVELY-FILING entity; four famous names' obvious
-- matches were dead entities caught by latest-filing-date disambiguation
-- (Appaloosa's pre-2016 shell, Baupost's 2002 adviser, Trian's GP, ValueAct's
-- 2008 entity), and Einhorn's active filer is DME Capital Management, not
-- GREENLIGHT CAPITAL INC (stopped 2024-02).
--
-- coverage_start stays NULL here: it is recorded by the 13F-03 backfill job
-- (or the first live poll), because seeding it now would claim observation
-- that has not happened. NULL means "not yet observing", and nothing may cite
-- a watching-since claim from a NULL.
--
-- tier 1 = individual cards. tier 2 = digest only. (13F-04 consumes tiers.)

-- Tier 1 (15)
INSERT INTO managers_13f (cik, name, tier, added_at) VALUES
  ('1067983', 'BERKSHIRE HATHAWAY INC', 1, '2026-08-04T00:00:00.000Z'),
  ('1649339', 'Scion Asset Management, LLC', 1, '2026-08-04T00:00:00.000Z'),
  ('1336528', 'Pershing Square Capital Management, L.P.', 1, '2026-08-04T00:00:00.000Z'),
  ('1536411', 'Duquesne Family Office LLC', 1, '2026-08-04T00:00:00.000Z'),
  ('1656456', 'Appaloosa LP', 1, '2026-08-04T00:00:00.000Z'),
  ('1061768', 'BAUPOST GROUP LLC/MA', 1, '2026-08-04T00:00:00.000Z'),
  ('1040273', 'Third Point LLC', 1, '2026-08-04T00:00:00.000Z'),
  ('1489933', 'DME Capital Management, LP', 1, '2026-08-04T00:00:00.000Z'),
  ('921669', 'ICAHN CARL C', 1, '2026-08-04T00:00:00.000Z'),
  ('1029160', 'SOROS FUND MANAGEMENT LLC', 1, '2026-08-04T00:00:00.000Z'),
  ('1791786', 'Elliott Investment Management L.P.', 1, '2026-08-04T00:00:00.000Z'),
  ('1517137', 'Starboard Value LP', 1, '2026-08-04T00:00:00.000Z'),
  ('1345471', 'TRIAN FUND MANAGEMENT, L.P.', 1, '2026-08-04T00:00:00.000Z'),
  ('1167483', 'TIGER GLOBAL MANAGEMENT LLC', 1, '2026-08-04T00:00:00.000Z'),
  ('1166559', 'GATES FOUNDATION TRUST', 1, '2026-08-04T00:00:00.000Z');

-- Tier 2 (21)
INSERT INTO managers_13f (cik, name, tier, added_at) VALUES
  ('1350694', 'Bridgewater Associates, LP', 2, '2026-08-04T00:00:00.000Z'),
  ('1103804', 'VIKING GLOBAL INVESTORS LP', 2, '2026-08-04T00:00:00.000Z'),
  ('1061165', 'LONE PINE CAPITAL LLC', 2, '2026-08-04T00:00:00.000Z'),
  ('1135730', 'COATUE MANAGEMENT LLC', 2, '2026-08-04T00:00:00.000Z'),
  ('1541617', 'Altimeter Capital Management, LP', 2, '2026-08-04T00:00:00.000Z'),
  ('1697748', 'ARK Investment Management LLC', 2, '2026-08-04T00:00:00.000Z'),
  ('1709323', 'Himalaya Capital Management LLC', 2, '2026-08-04T00:00:00.000Z'),
  ('1549575', 'Dalal Street, LLC', 2, '2026-08-04T00:00:00.000Z'),
  ('915191', 'FAIRFAX FINANCIAL HOLDINGS LTD/ CAN', 2, '2026-08-04T00:00:00.000Z'),
  ('1096343', 'MARKEL GROUP INC.', 2, '2026-08-04T00:00:00.000Z'),
  ('1374170', 'NORGES BANK', 2, '2026-08-04T00:00:00.000Z'),
  ('1767640', 'PUBLIC INVESTMENT FUND', 2, '2026-08-04T00:00:00.000Z'),
  ('1021944', 'Temasek Holdings (Private) Ltd', 2, '2026-08-04T00:00:00.000Z'),
  ('1647251', 'TCI Fund Management Ltd', 2, '2026-08-04T00:00:00.000Z'),
  ('923093', 'TUDOR INVESTMENT CORP ET AL', 2, '2026-08-04T00:00:00.000Z'),
  ('1418814', 'ValueAct Holdings, L.P.', 2, '2026-08-04T00:00:00.000Z'),
  ('1998597', 'JANA Partners Management, LP', 2, '2026-08-04T00:00:00.000Z'),
  ('1582090', 'Sachem Head Capital Management LP', 2, '2026-08-04T00:00:00.000Z'),
  ('1138995', 'GLENVIEW CAPITAL MANAGEMENT, LLC', 2, '2026-08-04T00:00:00.000Z'),
  ('1387322', 'Whale Rock Capital Management LLC', 2, '2026-08-04T00:00:00.000Z'),
  ('1747057', 'D1 Capital Partners L.P.', 2, '2026-08-04T00:00:00.000Z');
