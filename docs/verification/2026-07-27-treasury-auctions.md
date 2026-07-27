# Verification: TreasuryDirect auction results — 2026-07-27T22:42Z

`https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&pagesize=40`

**HTTP 200, 17,934 bytes, 5 auctions.** No auth, no WAF, no HTML anywhere in
the path. Declared UA `Skeptic Wire admin@spechawk.ai`.

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
