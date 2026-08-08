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

## UN News as a geopolitics source

**What.** The UN News global feed
(`news.un.org/feed/subscribe/en/news/all/rss.xml`) as an ingested source under
p5-22.

**Why.** It is live and parseable: 200, 30 items, verified 2026-08-07. The
problem is fit, not reachability. Sampled the same minute, the feed carried
childhood Ebola deaths in DR Congo, the deadliest attack on Kyiv this year,
gang violence in Haiti, 300 children killed in Gaza, and a story about a
peacock. One item in twelve was market-adjacent.

A market-intelligence desk republishing casualty counts and outbreak deaths as
signal is not noisy, it is wrong. The desk has no standing to frame those as
market events and no archetype that could carry them honestly.

**What would reopen it.** A UN feed scoped to economic or trade output
specifically (UNCTAD statistics, a sanctions-committee decisions feed), where
every item is a document rather than a dispatch. The global news feed itself
does not reopen.

## China official-English lane (p5-23)

**What.** PBoC, NBS, CSRC, MOFCOM and China Customs English pages as ingested
sources.

**Why.** No machine-readable endpoint exists. Eight paths probed across two
rounds on 2026-08-07: PBoC, NBS, CSRC and Customs each return a 200 HTML page
with no feed, MOFCOM and the `.rss` variants 404. Reachability was never the
issue; there is simply nothing structured to parse.

Building it means HTML content-diff against foreign government pages with no
declared feed, no stated UA policy, and no change notification. That is a
fragile parser aimed at a source that has not agreed to be parsed, and it
would break silently.

**What would reopen it.** Any of these bodies publishing an English RSS/Atom
feed or a documented API. Re-probe costs ten minutes; the paths are recorded in
`verification/2026-08-07-geopolitics-china-usda-endpoints.md`.

## USDA WASDE lane (p5-24) — pending one owner action

**What.** The WASDE report and USDA/NASS releases as an ingested source.

**Why.** Ten paths probed across two rounds on 2026-08-07. Every RSS path is
404 or 403, both Cornell Mann library routes 404, and the WASDE page itself is
a 164 KB HTML page with no feed. The one live structured route is the **NASS
QuickStats API, which returns 401 without a key**.

**What would reopen it.** A free NASS QuickStats API key, which is an owner
action rather than a decision. With the key this lane is buildable
immediately; without it, content-diffing a monthly 164 KB HTML page is the
only route and is not worth the fragility.
