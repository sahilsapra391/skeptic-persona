# RBA cash rate target — endpoint verification

**Verified:** 2026-07-28T05:50Z
**Source:** Reserve Bank of Australia, F1 Interest Rates and Yields – Money Market

## Endpoint

`https://www.rba.gov.au/statistics/tables/csv/f1-data.csv` → **200**, 304,224 bytes,
`content-type: application/octet-stream`, `last-modified: Mon, 27 Jul 2026 22:59:33 GMT`.

Human page carried as the post's source link:
`https://www.rba.gov.au/statistics/cash-rate/`.

## Values at verification

| Field | Value |
|---|---|
| Cash Rate Target | **4.35%** (27-Jul-2026) |
| Last change | 06-May-2026, 4.10% → 4.35% (+25bp) |
| Prior changes | 18-Mar-2026 3.85→4.10; 04-Feb-2026 3.60→3.85 |
| Data rows | 3,939 (daily, back to 04-Jan-2011) |

## Shape, and the two traps in it

The file is a CSV whose first nine rows are metadata, not data. Columns are
identified on a dedicated `Series ID` row; the cash rate target is
**`FIRMMCRTD`**, at index 1 today.

1. **Read the column by Series ID, never by position.** The table carries 17
   columns spanning RBA, ASX and FENICS series. Order is the RBA's to change;
   the published identifier is the stable thing. The test swaps two columns
   and asserts the parser follows the id.

2. **The newest row has an EMPTY cash-rate cell.** The table is published
   before the day's value is set:

   ```
   28-Jul-2026,,,,,,,,145.498780
   ```

   An empty cell must produce no observation. Coerced to a number it would be
   `0`, which reads as a cut to zero percent — the worst possible fabrication
   for this source. Pinned by a test.

## Endpoints checked and rejected

| URL | Result |
|---|---|
| `rba.gov.au/statistics/tables/xls/f01hist.xls` | 404 (HTML body) |
| `rbnz.govt.nz` (New Zealand, two paths) | 403 to a declared UA |
| `boi.org.il/PublicApi/GetInterest` | 200, but returns ONLY the current level with no history, so `detectChange` can never find a prior. Needs a framework capability (use the stored cursor as the prior observation) before it can post. Deferred, not adopted. |
| `bok.or.kr` (Korea) | 200 but 412KB of portal HTML |
| `api.eia.gov` | 403 without a key |
| `oui.doleta.gov/unemploy/wkclaims/report.asp` | **200 carrying an error message** — "An attempt to run the report without providing user input was made." Needs a POST with form state. |
| `ofac.treasury.gov/rss.xml` | **200 with a valid RSS feed of the wrong thing** — sanctions *programs*, 10 items, pubDates 2022–2025, not recent actions. |

The last two are worth keeping on the record: both return 200 with
well-formed bodies. A status check accepts them and a content-type check
accepts them. Only reading the content rejects them.
