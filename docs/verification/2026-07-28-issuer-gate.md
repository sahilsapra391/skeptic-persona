# Issuer reference table — endpoint verification and sizing

**Verified:** 2026-07-28

## Endpoints

| URL | Result |
|---|---|
| `https://www.sec.gov/files/company_tickers_exchange.json` | 200, 522KB, 10,419 rows |
| `https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/CY2025Q2I.json` | 200, 4,280 entries |
| `.../CY2025Q1I` `Q3I` `Q4I` `CY2026Q1I` | 200; 320 / 244 / 260 / 34 entries |

Union of the five frames covers **5,091 CIKs**.

Exchange mix in the ticker file: Nasdaq 4,341, NYSE 3,308, OTC 2,558,
no-exchange 185, CBOE 27.

## Why float scatters across frames

`dei:EntityPublicFloat` is measured at the last business day of a registrant's
most recently completed **second fiscal quarter**. December filers land in
`CY..Q2I`; everyone else scatters, and some fall outside a five-frame window
entirely. Donaldson (July FYE) and Estée Lauder (June FYE) are both absent
from the union, which is why the gate must treat a missing float as unknown.

## Measured against 447 live 8-K items

| Rule | Kept | Filtered |
|---|---|---|
| Major exchange only | 372 | 17% |
| + float ≥ $50M | 306 | 32% |
| **+ float ≥ $300M (default)** | **240** | **46%** |
| + float ≥ $1B | 191 | 57% |
| + float ≥ $2B | 162 | 64% |

What the exchange rule alone removes: BlackRock Private Credit Fund, KKR
Infrastructure Conglomerate, KKR Private Equity Conglomerate, Golub Capital
Private Credit Fund, Ares Strategic Income Fund, Eagle Point Trinity Senior
Secured Lending, plus OTC names like SharonAI Holdings and Helio Corp.

## The zero-float trap

Eight major-exchange 8-K filers report a float of **exactly zero**: Solstice
Advanced Materials (a Honeywell spinoff), CoastalSouth Bancshares, Avidia
Bancorp, MapLight Therapeutics, 21Shares Solana ETF and others. These are
recent IPOs and spinoffs whose float measurement date predates their listing.

Zero here means "was not public yet", not "worth nothing". `parseFloatFrame`
drops non-positive values so they read as UNKNOWN, and `keepIssuer` keeps
unknowns. A rule reading missing-as-zero would have silenced a Honeywell
spinoff's first 8-K, which is exactly the filing worth having.

## Gate direction

Fails **open**. Only a positive finding suppresses: no listing, a minor
exchange, or a float the issuer itself reported below the floor. An issuer
absent from the table has not been shown to be small — the refresh is weekly
and a fresh listing appears late.

Floor is `MIN_ISSUER_FLOAT_USD`, default $300,000,000.

## Correction, same day: absence was not being used

The measurement above counted "not in SEC's ticker file" as filtered, and the
first implementation did the opposite: `keepIssuer(null)` returned keep.

That gap was the single worst bucket. Measured against 455 live 8-K items
once the reference table was populated in production:

| Bucket | Items |
|---|---|
| Major exchange | 373 |
| **Absent from the reference** | **45** |
| Minor exchange or none | 37 |

Every one of the 45 is a non-traded vehicle: BlackRock Private Credit Fund,
Blackstone Private Credit Fund, KKR Infrastructure Conglomerate, KKR Private
Equity Conglomerate, three Golub Capital funds, PennantPark Private Income
Fund, Ares Strategic Income Fund, Eagle Point Trinity Senior Secured Lending.

SEC's ticker file lists every exchange-listed issuer, so a filer missing from
a COMPLETE and FRESH copy of it is not listed. Absence is now evidence.

### But only from a table that covers the market

An empty or partial table cannot distinguish "not listed" from "not refreshed
yet", and reading a failed refresh as "nothing is listed" would silence the
entire 8-K source at once. The gate therefore only draws the negative
inference when the reference holds at least `MIN_AUTHORITATIVE_ROWS` (5,000)
and was updated within `MAX_REFERENCE_AGE_DAYS` (7). Production currently
holds 8,014 rows.

Below either bar the gate degrades to passing filings through, which is the
same direction it already fails for an unknown float.

## Production state, 2026-07-28T17:10Z

8,014 issuers (Nasdaq 3,345, NYSE 2,474, OTC 2,025, no-exchange 151, CBOE 19),
4,357 with a public float. Fewer rows than the 10,419 in SEC's file because
the table is keyed by CIK and share classes collapse.

Spot-checked against the live values: AAPL $3.25T, NVDA $4.0T, AIR (AAR Corp)
$3.224B, all matching the source exactly.
