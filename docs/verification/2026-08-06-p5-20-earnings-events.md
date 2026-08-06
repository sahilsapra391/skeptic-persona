# p5-20 verification: the earnings-event lane

**Verified 2026-08-06** against the live `skeptic-wire` D1 and four real item-2.02
filings that arrived the same afternoon.

## The lane is defined by a refusal

Item 2.02 announces that results were released. The results themselves are in
Exhibit 99.1, a **press release** — prose. Pulling EPS or revenue out of prose
is number extraction from unstructured text, and a misread decimal in an
earnings figure is the most damaging thing this desk could publish.

So the lane posts the **event**: who filed, for which period when the SEC
states one, when, and where to read it. The reader gets the filing seconds
after it exists. The numbers are one click away in the issuer's own words.

Enforced structurally, not by discipline:

- `buildEarningsPayload` emits **no earnings figure of any kind**, asserted by
  a test over the payload's key set.
- The archetype's only interpolation slot in any beat is
  `{sameItemOccurrence}` — a count of filings **in our own lake**, not a figure
  from a release. Asserted by extracting every slot from the beat library and
  comparing the whole list.

## Measured before designing, not after

```
8-K items stored                3,440
  resolving to an issuer row    3,189   92.7%
item 2.02 filings in the lake   1,834
issuers                         8,056
  with a ticker                 8,056   100%
  with public_float             4,380   54.4%
```

Two design rules fall straight out of those numbers.

**A cashtag is a lookup, never a guess.** It resolves through `issuers` on
**CIK** — the SEC's own identifier, stable across filing agents and name
changes. The 7.3% that do not resolve render the **filed company name**.
(`cusip_map` is the wrong table here: it is CUSIP-keyed because it exists for
13F holdings, and an 8-K carries no CUSIP. Same rule, right key.)

**A float may raise salience and may never gate it.** Only 54.4% of issuers
carry one, so an issuer without a float is **unmeasured, not small**. Demoting
it would suppress real news from nearly half the universe on the strength of a
missing field — precisely the "absence we did not parse" the never-list
forbids asserting. `sizeBump("unmeasured")` and `sizeBump("small")` are both
`0`, asserted in both directions.

Size thresholds are **the SEC's own filer categories**, not numbers invented
here: $700M is the large-accelerated-filer floor and $75M the accelerated
floor (17 CFR 240.12b-2). Using the regulator's own bands means the tiering
can be explained without appealing to taste.

## The period is stated or omitted, never inferred

`periodLabel` names a calendar quarter only when the period **end** is one
(Mar/Jun/Sep/Dec). A non-standard fiscal close renders "the period ended
July 2026". When the SEC states no period, the card **omits it** — inferring
"Q2" from a filing date would be a claim about which quarter a company
reported, and that is the kind of small confident wrongness that costs a wire
its credibility.

## Routing: 4.02 outranks 2.02

A filing that both reports results and says prior financials cannot be relied
upon is a **non-reliance story**. Carding it as a routine earnings event would
bury the only part that matters, so it stays `FILING_8K`. Asserted.

## Live output, four real filings from 2026-08-06

```
$WHWK  Whitehawk Therapeutics   small         salience 50   121 weighted
$YORW  YORK WATER CO            accelerated   salience 58   121 weighted
$MHH   Mastech Digital          unmeasured    salience 50   126 weighted
$BKV   BKV Corp                 accelerated   salience 58    56 weighted
```

```
$YORW filed its results with the SEC on August 6, per SEC

The numbers are in the issuer's own release, not in this post.
```

Every one resolves a cashtag, cites the SEC, and states no figure. `$MHH` is
the unmeasured case carding normally on a `small`-equivalent score, which is
the rule working.

## The card

`EARNINGS_EVENT` gets the **event card**, a new template with no hero figure.
Reusing the single-stat template would have meant finding something to put in
the hero slot, and the only honest candidates were a date or a ticker dressed
up as a statistic. **A card with no big number is the accurate rendering of a
filing with no parsed number.**

## Per-lane rates in the digest

`laneRates` counts cards, approvals and posts **per archetype**, over the same
cohort and with the same state-UNION-`post_log` rule as the north star.
Counting state alone loses every card that went on to post — PR #115 measured
that as the difference between 0.22% and 2.17% pipeline-wide, and the test
pins the union with a row approved only through `post_log`.

Lane value is what this measures: a lane that cards a lot and is approved
rarely is costing the owner attention, and that should be visible per lane
rather than averaged away.

## Monthly cost line

**$0 delta.** No new job, no new poll, no new egress: the lane rides the
existing `edgar_8k` poll and adds one indexed `issuers` lookup per 2.02
filing at drain time. D1 reads only.

## Tests

13 added (`test/earnings.test.ts` 12, per-lane rates 1). Suite **1,170
passing**, 1 pre-existing failure (D-6).

## Owed to the owner

The exemplar payload pack is in
[`docs/packs/2026-08-06-earnings-payloads.md`](../packs/2026-08-06-earnings-payloads.md).
Voice stays owner-written; nothing in this lane ships an owner exemplar until
he sends one.
