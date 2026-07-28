# Evaluation: FINRA consolidated short interest — DEFERRED 2026-07-28T04:57Z

`https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest`

**Reachable, free, unauthenticated — and deliberately not built.** Recording
the findings so the next attempt starts here rather than repeating them.

## THE STALE-DATA TRAP IS REAL

A naive `GET ?limit=3` returns **April 2020** data:

```
accountingYearMonthNumber,symbolCode,...,settlementDate
20200415,A,Agilent Te...
```

An ingester built on the obvious call would publish **six-year-old short
interest as current**. This is the "stale-data-as-current" fabrication mode:
the arithmetic is fine, the number is real, the claim is false.

Also note the response is **CSV**, despite the JSON-shaped API path.

## Sorting requires the partition key first

```
{"statusCode":400,"message":"Sorting is allowed only if all partitions keys
 are specified in EQUAL CompareFilter..."}
```

So you cannot ask for "the newest settlement". You must already know the
settlement date, pin it with an EQUAL filter, and only then may you sort.

What works:

| Request | Result |
|---|---|
| `POST {dateRangeFilters:[{fieldName:"settlementDate",startDate,endDate}]}` | 200, returns the OLDEST in range |
| `POST {compareFilters:[{fieldName:"settlementDate",fieldValue:"2026-07-15",compareType:"EQUAL"}]}` | 200, that settlement |
| the above **plus** `sortFields:["-daysToCoverQuantity"]` | 200, sorted |

## The ranking is junk without a liquidity floor

Sorting the 2026-07-15 settlement by days-to-cover descending returns:

```
AACAF  dtc=999.99  short=4,454,640   AAC Technologies
AAGRW  dtc=999.99  short=272         AFRICAN AGRICULTURE HLDGS
AAHIF  dtc=999.99  short=54,440      Asahi Co Ltd
```

`999.99` is a **sentinel/cap** for illiquid OTC names with almost no volume —
one of them has **272 shares** short. "Highest days to cover" surfaces
noise, not news, so a usable version needs a compound filter on both short
quantity and average daily volume, plus thresholds someone has to defend.

## Why deferred rather than built

1. **Engagement is unmeasurable.** The competitor study found short interest
   at n=8 on the only account that posts it — below the n>=25 bar the
   per-account measurement requires, so there is no evidence it performs.
2. **Settlement dates must be discovered by probing** (semi-monthly, 15th and
   month-end, published ~8 business days later), which is 1-3 extra requests
   before any data.
3. **The editorial thresholds are the real work**, not the plumbing.

None of that is blocking. It is simply worse value per hour than the filing
sources the coverage analysis identified as whitespace, and half-building it
would leave a source that looks alive while publishing OTC noise.
