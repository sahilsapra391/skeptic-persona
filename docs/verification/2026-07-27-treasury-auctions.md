# Verification: US Treasury auctions — 2026-07-27 / 2026-07-28

## HOST CHANGE: treasurydirect.gov FAILS from Cloudflare Workers (HTTP 525)

The original endpoint, `https://www.treasurydirect.gov/TA_WS/securities/auctioned`,
returns **200 from a residential connection** and **HTTP 525 from Cloudflare
Worker egress**. Six consecutive production polls failed. The error, captured
after the ingester was changed to report status, content-type and body:

```
treasury 525 type=text/plain; charset=UTF-8 body=error code: 525
```

**525 is a TLS handshake failure** between Cloudflare and the origin. It is
not a bot block and not a code bug — the handshake never completes, so no
header tuning, UA change or retry would help. This is a THIRD distinct
egress-failure mode, after Senate eFD (403 to datacenter IPs) and NSE India
(UA-based connection reset).

**Resolution:** switched to Treasury's own modern API gateway,
`api.fiscaldata.treasury.gov`, which carries the same auction results.

---



## Fiscal Data endpoint (in use)

`https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query?sort=-auction_date&page[size]=40`

**HTTP 200, 147,702 bytes, 40 auctions.** No auth. Declared UA
`Skeptic Wire admin@spechawk.ai`.

Verified live 2026-07-28T01:10Z, 13-Week Bill cusip 912797SK4, auctioned
2026-07-27: bid-to-cover **3.06**, $92.0B offered, $279.6B tendered,
allocation 83.44%, indirect share 66.9%.

### Two shape differences from TA_WS

1. Fields are **snake_case** (`auction_date`, `bid_to_cover_ratio`,
   `comp_accepted`) and wrapped in a `{ data: [...] }` envelope.
2. Absent values arrive as the **STRING `"null"`**, not JSON null. Coercing
   that would print `NaN` or silently become 0, so the parser rejects it
   explicitly.

### Announced-but-unheld auctions

The newest rows are auctions that have been ANNOUNCED but not yet held, with
every result field `"null"` (e.g. auction_date 2026-07-29 seen on 07-28).
Scoring requires a parsed bid-to-cover, so those exclude themselves. Note
that scoring does NOT require high_yield: bills price on a discount rate and
legitimately carry `high_yield = "null"`.

### Original TA_WS record (kept for reference)

## Same-day results confirmed

Checked at 22:42Z on **27 July**, the page already carried auctions **held
that day** — this is not a next-morning feed:

| Term | Type | Auction date | Bid-to-cover |
|---|---|---|---|
| 2-Year | Note | 2026-07-27 | 2.66 |
| 5-Year | Note | 2026-07-27 | 2.28 |
| 13-Week | Bill | 2026-07-27 | 3.06 |
| 26-Week | Bill | 2026-07-27 | 3.12 |
| 10-Year | Note | 2026-07-23 | 2.30 |

## Fields verified (2-Year Note, cusip 91282CRB9)

```
securityType            Note
securityTerm            2-Year
auctionDate             2026-07-27T00:00:00   <- zone-less; a calendar date
issueDate               2026-07-31T00:00:00
offeringAmount          69000000000
highYield               4.3150
bidToCoverRatio         2.660000
allocationPercentage    69.040000
competitiveTendered     182453432000
competitiveAccepted     67776042400
indirectBidderAccepted  38355032000
directBidderAccepted    23080167200
primaryDealerAccepted   6340843200
noncompetitiveAccepted  919081500
somaAccepted            7628718200
interestRate            4.250000
pricePer100             99.876720
tips / floatingRate     No / No
```

Every value arrives as a **string**, including the numerics, so parse as
float rather than trusting JSON types.

## Notes for the ingester

- `auctionDate` carries no timezone marker. It is a calendar date, so we take
  the date part rather than parsing it as UTC midnight and re-rendering,
  which could shift the day for readers behind UTC.
- `indirectBidderAccepted / competitiveAccepted` gives the indirect share
  (56.6% here) from two parsed fields and one division. Null when either is
  absent.
- **NO TAIL, EVER.** An auction tail is the high yield minus the
  *when-issued* yield at the bid deadline. WI is dealer/vendor data we cannot
  license, so computing or implying a tail from these fields alone would be
  fabrication wearing the clothes of arithmetic.
- Bills print several times a week and rarely carry a story; they are ingested
  to the lake and only coupons (Note/Bond/TIPS/FRN) reach the queue.
