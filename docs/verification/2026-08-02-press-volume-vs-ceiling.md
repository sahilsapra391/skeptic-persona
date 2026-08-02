# The ceiling exemption was sized for six press sources; there are now 26

**Measured 2026-08-02T05:1xZ against remote D1**, after migrations 0056–0058
were applied and the first post-migration tick ran at 05:10.

Not a defect report. A number the owner should see before the next full day of
polling, because **the thing that changed is mine**: I took `PRESS_SOURCES`
from 6 to 26 tonight, and the category those sources feed is the one category
with no daily cap.

## The migration is healthy — that part first

| check | result |
|---|---|
| press job rows | **26**, all `enabled=1` |
| polled at the 05:10 tick | all, `consecutive_failures=0`, no `last_error` |
| items ingested that tick | **448** |
| items with no parseable date | **0** |
| postable items wrongly marked fresh | **0** |

Every one of the 373 postable-but-logged items was genuinely stale: 253 over
seven days old, 75 at two-to-seven days, 46 at 24–48h, and **none under 24h**.
That is the stale-at-ingest gate doing exactly its job on a first poll, and it
confirms date parsing works across all four dialects in production.

`fda_device_recall` also polls, holds 12 items and queued its first card.

Two jobs read `last_ok_at = NULL` mid-investigation and both were my own
observation racing the tick — they were correct two minutes later.
`bls_watch` reads `NULL` legitimately: it is calendar-driven, `every_30m` is
only its fallback heartbeat, and `sourceHealth.ts` already documents it.

## The number

`salienceFor` has **no `case "REGULATORY_NEWS"`**. Every press item scores the
flat base of **70**, against a floor of 45, and `REGULATORY_NEWS` is in
`CEILING_EXEMPT`. So every press item from every one of the 26 sources pushes,
uncapped, and nothing distinguishes them from each other.

Publication rates from each source's own backfill window:

```
press_sebi 30/day   press_doj 25/day   press_rbi 10/day   press_cma 6.5/day
press_ons   5/day   press_eu_commission 4/day   press_boj 2.9   press_gao 2.8
…19 more, most under 1/day
```

Short windows overstate — SEBI's 30 items span two days because the feed holds
30, not because it publishes 30 daily. The defensible range is **50–90 press
items a day**, all scoring 70, all exempt.

The owner's target is **25/day soft across everything**, and the salience
replay measured the pipeline down to ~30/day. Press alone would be two to
three times the whole target, and the cap that holds every other category
cannot touch it.

## What the exemption has bought so far

Every `REGULATORY_NEWS` card ever created:

| state | n |
|---|---|
| expired | 37 |
| pending | 1 |
| approved | **1** |

**Stated fairly:** 1 in 39 is 2.6%, and the pipeline-wide approval rate is
2.18%. Press is **not** an underperforming category — it converts at the
average. The problem is not its value; it is that the exemption removes the
cap from the category whose source count just quadrupled, while every category
that does convert at the same rate stays capped.

## The code exempts more than the decision does

Plan of record, owner verbatim:

> **Congress PTRs and enforcement actions are EXEMPT from the daily ceiling.**
> "if a day produces 30 genuinely high-salience items, push them and let the
> low-salience categories absorb the squeeze via digests."

The decision says **enforcement actions**. The code says `REGULATORY_NEWS`.

With the original six — SEC enforcement, CFTC enforcement, FTC competition,
DOJ, FCA, EU Commission — those two phrasings picked out nearly the same set,
so the gap cost nothing. The exemption now also covers SEBI recovery
certificates, ONS release-calendar entries, GAO reports, BEA statistical
releases and FINMA ordinance notices. **The wording did not change; the
population under it did.**

## Proposal, and deliberately not implemented

The faithful fix is to discriminate *within* `REGULATORY_NEWS` so enforcement
actions keep the exemption the owner granted them and routine publication
falls toward the floor and into the digest — which is the mechanism his own
sentence describes ("let the low-salience categories absorb the squeeze").

Mechanically that is a tier declared per authority, in a leaf module keyed the
same way `PRESS_ATTRIBUTION` is, read by a new `case "REGULATORY_NEWS"` in
`salienceFor`, with `exempt` computed from the tier rather than from the
archetype alone.

**The weights are not mine to pick and I have not picked them.** Choosing how
far below the floor an ONS release-calendar entry should sit is an editorial
call, and the one number I could invent to justify it — "statistics are worth
-30" — would be exactly the kind of constant this project has spent two days
proving nobody should tune against a fixture. The salience layer's own rule
applies: bases encode ordering, measured, never a coefficient someone guessed.

Two things also need the owner rather than me:

- **BEA is not ONS.** A GDP advance estimate and a release-calendar entry are
  both "statistics" and are not both routine. A tier per authority may be too
  coarse.
- **The first full day of data settles the range.** These rates come from
  backfill windows, some only two days wide. One steady-state day across all
  26 gives the real number, and it arrives tomorrow at no cost.

Recorded now rather than after that day, because the exemption is live and the
next full poll cycle is the one that spends it.
