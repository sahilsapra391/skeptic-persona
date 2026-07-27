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
| Swiss National Bank (RSS-CB) | `/public/en/rss/interestRates` | 200, 73,741 B | **0.25%** |

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
