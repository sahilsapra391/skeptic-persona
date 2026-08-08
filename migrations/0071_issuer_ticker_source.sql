-- p6-02 (B-15.4): make the issuer ticker choice auditable.
--
-- The upsert is keyed on cik while SEC's file is one-to-many (10,398 rows over
-- 7,999 CIKs), so ON CONFLICT DO UPDATE was settling 1,452 CIKs by whichever
-- row happened to come last. 269 production rows held a preferred series --
-- BANK OF AMERICA at MER-PK, WELLS FARGO at WFC-PZ, MORGAN STANLEY at MS-PQ.
--
-- Selection is explicit now (src/ingesters/issuers.ts selectIssuerTicker) and
-- this column records WHICH rule produced the ticker, so a wrong cashtag can
-- be traced to a decision rather than to a coin flip.
--
--   sec_primary      unsuffixed symbol on Nasdaq/NYSE/CBOE
--   sec_primary_otc  unsuffixed symbol, OTC only
--   sec_share_class  no unsuffixed symbol exists; dual-class common (BRK-A)
--   unresolved       preferred / warrants / units / rights only -> NO ticker,
--                    and the lane falls back to the issuer name as filed
ALTER TABLE issuers ADD COLUMN ticker_source TEXT NOT NULL DEFAULT '';

-- Share-class alternatives, populated ONLY for the ~20 CIKs that list no
-- unsuffixed symbol (BRK-A/BRK-B, BF-A/BF-B, CRD-A/CRD-B). The resolution
-- chain uses them to honour B-10.4 tier 2: prefer the class the filing itself
-- names, rather than the alphabetical default.
ALTER TABLE issuers ADD COLUMN ticker_alts TEXT NOT NULL DEFAULT '';
