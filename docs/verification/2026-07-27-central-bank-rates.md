# Verification: central bank policy rates — 2026-07-27T22:30Z

All five live-checked with the declared UA `Skeptic Wire admin@spechawk.ai`.
Every one returned HTTP 200 with a parseable body; fixtures captured in
`test/fixtures/rate-*.{json,xml.fixture}` are the parse contract.

| Source | Endpoint | Status | Level observed |
|---|---|---|---|
| Bank of Canada (Valet) | `/valet/observations/V39079/json?recent=10` | 200, 871 B | **2.25%** (2026-07-24) |
| Riksbank (SWEA) | `/swea/v1/Observations/SECBREPOEFF/2026-01-01` | 200, 2,066 B | **1.75%** |
| Banco Central do Brasil (SGS 432) | `/dados/serie/bcdata.sgs.432/dados/ultimos/20` | 200, 115 B | **14.25%** (Selic) |
| South African Reserve Bank | `/SarbWebApi/WebIndicators/CurrentMarketRates` | 200, 5,310 B | **7.00%** |
| Swiss National Bank (RSS-CB) | `/public/en/rss/interestRates` | 200, 73,741 B | **0.00%** (SNBLZ) |
| Bank of England (IADB) | `/boeapps/iadb/fromshowcolumns.asp?...SeriesCodes=IUDBEDR` | 200, 2,570 B | **3.75%** (24 Jul) |
| European Central Bank (SDMX) | `/service/data/FM/D.U2.EUR.4F.KR.MRR_FR.LEV?format=csvdata` | 200, 2,303 B | **2.40%** (27 Jul) |

## Shapes

- **BoC**: `observations[]` newest-first; the value is nested per series id —
  `{"d": "2026-07-24", "V39079": {"v": "2.25"}}`. String numeric.
- **Riksbank**: `[{"date":"2026-05-04","value":1.75}]`. ISO dates, native
  numbers, no nesting. The simplest feed in the set.
- **BCB**: `[{"data":"03/08/2026","valor":"14.25"}]`. DD/MM/YYYY, string
  values.
- **SARB**: a mixed indicator array; the policy rate is the row where
  `Name == "SARB Policy Rate"`. Also carries an `UpDown` direction flag we do
  not rely on (we compute direction from two parsed levels).
- **SNB**: RSS carrying the CBWiki `cb:` namespace, so **the number is inside
  the feed** (`cb:value`) and no second fetch is needed.

  **CORRECTION (2026-07-27T23:40Z, after a production failure.)** `cb:rateName`
  carries CODES, not prose. The live values are `SNBLZ`, `LSFF`, `R10`,
  `SARH`, `SNBFBF`, `SNBGIRO1`, `SNBGIRO2`, `Discount`. The first
  implementation filtered on the human label "SNB policy rate", matched
  nothing, and the source failed every poll.

  The policy rate is **`SNBLZ` (Leitzins), reading 0.00%**. An earlier note in
  this file said 0.25% — that is `LSFF`, the special rate for
  liquidity-shortage financing, a different instrument that sits adjacent to
  the policy rate in the feed. Picking by position or by "the number near the
  top" would have published the wrong rate.
- **BoE**: two-column CSV, `DATE,IUDBEDR`, rows like `02 Jan 2026,3.75`. The
  REQUEST wants `DD/Mon/YYYY` and the RESPONSE returns `DD Mon YYYY` — two
  different formats in one round trip. The endpoint also requires an explicit
  date window, so the URL is built at poll time as a rolling year; a
  hard-coded `Dateto` would silently freeze the series.
- **ECB**: SDMX-CSV with ~30 columns. Columns are located by NAME
  (`TIME_PERIOD`, `OBS_VALUE`), never by position, so an upstream column
  addition cannot shift the parse.

## THE TRAP: forward-dated observations (Brazil)

Checked at 22:30Z on **27 July**, SGS series 432 returned rows dated
**03/08/2026, 04/08/2026, 05/08/2026** — all in the future. This is correct
behaviour on the Bank's side: the Selic target is published for the days it
will be in effect until the next Copom meeting.

Naively taking "the newest row" would publish a future-dated rate as today's.
`latestEffective()` filters to observations at or before today, and
`test/rates.test.ts` asserts both that the trap exists in the live fixture and
that we refuse it.

## Editorial note

These series reprint the same number every business day. A rate that did not
move is not news, so the ingester posts only an observed CHANGE, and the first
sighting of a series records a baseline and posts nothing — we cannot claim a
change we did not witness.
