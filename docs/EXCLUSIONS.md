# Exclusions register

Things this desk has decided **not** to do, so no future session re-proposes
them from scratch. Each entry: **what**, **why**, and **what would reopen it**.

An entry here is a closed decision. Reopening one needs a new owner ruling, not
a good argument.

> Started 2026-08-06 with the NSE/BSE ruling. **p5-40 completes this register**
> with the rest of the charter's standing exclusions (X scraping and the X API,
> vendor data, GDELT and aggregators as citation, outlet journalism as
> citation, ESMA until it publishes dates, invented timestamps, price feeds,
> crypto beyond regulatory actions). Those are all live decisions today; they
> are simply not yet written here.

---

## NSE / BSE official data licence

**Ruled:** 2026-08-06, owner. **Park.**

**What is excluded.** Any paid market-data or corporate-data licence from the
National Stock Exchange of India or BSE Ltd, and therefore any India equities
lane that would depend on one.

**Why.** Cost, measured rather than estimated, from BSE's own published
[Information Products Tariff, February 2025](https://www.bseindia.com/downloads1/Information_Products_Pricing_Sheet.pdf):

| Product (INR, annual, ex-tax) | Real-time | 5-min | 15-min delayed |
|---|---|---|---|
| Equity Data Level 1 | 1,000,000 | 300,000 | **150,000** |
| Corporate Announcements | 900,000 continuous | — | 500,000 EOD |

The cheapest tier that could serve a wire desk is **₹150,000/year**, about
**$139/month** at ₹90/USD. That is roughly **28x the $5/month per-lane cap**
and **5.5x the entire $25/month program ceiling**. Nothing on the sheet comes
within an order of magnitude, so the conclusion does not depend on the exchange
rate used.

Two structural terms compound it:

- That tariff is **domestic by its own header** (customers located or operating
  within India). This desk is US-based, so it falls on the **international**
  track, where **Deutsche Börse is the exclusive licensor** and international
  pricing is **not published at all**. BSE takes international licensing
  **in-house on 2027-01-01**, so anything signed now crosses a counterparty
  change mid-term.
- **NSE publishes no price list in any market.** Its data policy states pricing
  is set *"on an arm's length basis"* by its board, with possible relief for
  non-commercial users. That is a negotiation, not a number.

And there is no free path. Probed 2026-08-06 with our declared User-Agent:
`nseindia.com` would not connect at all, `nsearchives.nseindia.com` would not
connect, `bseindia.com` returned **403**. Both exchanges refuse our client, and
spoofing a User-Agent is closed by the charter. The honest choice is licence or
nothing, and the licence does not fit the budget.

**What would reopen it:**

1. An **official licence becoming materially cheaper** — most plausibly BSE's
   2027 in-house international rate card, if it prices a redistribution-light,
   low-volume use case near the program ceiling.
2. A **real audience or India signal** — evidence that this desk's readers care
   about Indian equities. Today they trade US options, and coverage is measured
   by what the desk publishes, not by what it could ingest.

Either one is an owner ruling, not an engineering judgement.

**Memo:** [2026-08-06 NSE/BSE data licence](memos/2026-08-06-nse-bse-data-licence.md)
