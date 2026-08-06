# Owner memo: NSE / BSE official data licence — cost and terms

**p5-13(a). One page, no build.** Decision: **buy, or park.** The plan's lean
was park. The numbers below support that, and they are now numbers rather than
a lean.

## Recommendation

**Park.** Not because the data is unattractive, but because the cheapest
licence tier that could serve this lane is roughly **thirty times the per-lane
budget** and **six times the entire program ceiling**. No amount of scoping
gets a paid Indian exchange feed under $5/month.

## What it costs, from BSE's own published sheet

Source: **BSE Information Products Tariff, February 2025**
([tariff sheet](https://www.bseindia.com/downloads1/Information_Products_Pricing_Sheet.pdf)),
extracted directly. All figures **INR, annual, exclusive of taxes**.

| Product | Real-time | 1-min | 2-min | 5-min | 15-min delayed |
|---|---|---|---|---|---|
| Equity Data Level 1 | 1,000,000 | 900,000 | 600,000 | 300,000 | **150,000** |
| Equity Data Level 2 | 1,000,000 | NA | NA | NA | NA |
| All Indices | 800,000 | 600,000 | 500,000 | 250,000 | 100,000 |

Corporate data, which is closer to what this desk actually posts:

| Product | Continuous | End of day |
|---|---|---|
| Corporate Announcements | 900,000 | 500,000 |
| Financial Results | 500,000 | 300,000 |
| Shareholding Pattern | 500,000 | 300,000 |
| All three, redistribution on an open website / mobile app | **1,200,000** | NA |

Also on the sheet: variable per-user fees of ₹650/month (Level 1) and
₹950/month (Level 2), and BSE **Commodity Derivatives** carrying a
"currently available free of charge" note. That free line is commodity
derivatives specifically, not BSE market data generally.

### Against our budget

The program ceiling is **$25/month total infrastructure**, and any single lane
projecting over **$5/month stops and reports**.

The cheapest tier above that could plausibly serve a wire desk is the 15-minute
delayed equity feed at **₹150,000/year**. Even at a generous ₹90 to the dollar
that is about **$1,670/year, roughly $139/month**. That is ~28x the per-lane cap
and ~5.5x the whole program ceiling. The conclusion does not depend on the
exact exchange rate; nothing in the table comes within an order of magnitude.

The end-of-day corporate announcements line, ₹500,000/year, is about
$5,550/year. Also not close.

## Two terms that matter more than the price

**1. That price list does not apply to us.** Its own header says it is
*"applicable for Datafeed customers located/operating within India who are
taking data directly from BSE or from BSE data vendors located/operating within
India."* This desk is US-based, so it falls on the **international** track,
where **Deutsche Börse is the exclusive licensor for BSE information products
to international customers** and a **Market Data Dissemination Agreement** is
required to redistribute electronically. International pricing is **not
published**. BSE has announced it will take international licensing **in-house
from 1 January 2027**, so any agreement signed now sits across a
counterparty change.

**2. NSE publishes no price list at all.** NSE's own data policy states pricing
is *"fixed on an arm's length basis"* and set *"in accordance with the price and
policy approved by its Board or a committee thereof"*, with the Board able to
consider reduced fees or waivers for **non-commercial users**. There is no
public tariff to quote. The route is a commercial conversation with **NSE Data
& Analytics Ltd** (marketdata@nse.co.in). Whether this desk would qualify as
non-commercial is exactly the sort of question that costs weeks and yields a
maybe.

## Measured today, and it reinforces the charter

Probed 2026-08-06 with our declared User-Agent:

```
https://www.nseindia.com/market-data/data-subscription-fees   -> no connection (000)
https://nsearchives.nseindia.com/.../Non_Display_Policy.pdf   -> no connection (000)
https://www.bseindia.com/                                     -> 403
https://www.bseindia.com/markets/MarketInfo/DataSubscription.aspx -> 403
```

Both exchanges refuse our client outright. That is the same finding the plan
already recorded ("blocked UAs; we do not spoof"), re-confirmed rather than
recalled. It is worth stating plainly: **there is no unpaid path here that
does not involve spoofing**, and spoofing is closed by the charter. The choice
really is licence or nothing.

## What would reopen this

- An audience signal that Indian equities matter to this desk's readers. There
  is none today; the audience trades US options.
- The owner raising the program ceiling in writing, which is the only thing
  that makes the arithmetic survivable.
- BSE's 2027 in-house international licensing publishing a rate card that comes
  in materially lower for a redistribution-light use case.

Until one of those, the lane stays frozen and this memo is the record of why.
