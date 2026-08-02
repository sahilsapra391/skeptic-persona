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
2.17% (20 of 920). Press is **not** an underperforming category — it converts
at the average. The problem is not its value; it is that the exemption removes
the cap from the category whose source count just quadrupled, while every
category that does convert at the same rate stays capped.

### Count approvals as `state ∪ post_log`, or every rate here is wrong

`queue.state='approved'` alone returns **2**. Eighteen more sit in `post_log`
with `queue.state='expired'`, which the salience record already documents:

> 18 `post_log` rows have `queue.state='expired'` … Reading `queue.state`
> alone undercounts approvals by 18 and makes six archetypes look uniformly 0%.

Counting one column gives a pipeline rate of 0.22% and makes press look like
the only category converting at all, roughly 23x everything else. **That
figure is an artifact.** It is worth naming because the wrong number argues
for the wrong fix — "leave press uncapped, it is exceptional" — and the right
number does not.

Per archetype, counted correctly:

| archetype | cards | approved | rate |
|---|---|---|---|
| POLICY_ACTION | 19 | 6 | **31.6%** |
| POSITIONING | 8 | 2 | **25.0%** |
| INSIDER_NOTICE | 157 | 5 | 3.2% |
| **REGULATORY_NEWS** | **39** | **1** | **2.6%** |
| HALT | 219 | 3 | 1.4% |
| OWNERSHIP_STAKE | 86 | 1 | 1.2% |
| FILING_FORM4 | 97 | 1 | 1.0% |
| FILING_8K | 235 | 1 | 0.4% |

**REGULATORY_NEWS is mid-table.** `POLICY_ACTION` converts twelve times better
and is *also* `CEILING_EXEMPT` — which is the exemption earning its keep, and
the contrast any tier design should be aimed at.

At n=1 this cannot distinguish 2.6% from 0.5%. It rules out *"cap it because
it is noise"*. It does not support *"leave it uncapped because it is
exceptional"*.

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

**Keying on authority works, and it is worth stating because it looks like it
should not.** `press_sec_enforcement` and `press_sec_speeches` are the same
institution, so the obvious objection is that authority cannot separate them.
In production it does:

```
press_sec_enforcement   authority = "SEC"                 28 items
press_sec_speeches      authority = "SEC Commissioners"   25 items
```

Authority is unique per source by a **test-enforced invariant** —
`test/globalWire.test.ts`, *"gives each source its own authority, so no two
sources share a citation key"*. Since `payload.authority` is already written
into every press payload, `salienceFor(archetype, payload)` needs no signature
change and the leaf map is guarded against divergence by the parity test in
#110.

The registry also already groups these in prose: `regulatoryPress.ts` opens
one block `// --- Enforcement wire.` and another `// --- GLOBAL WIRE FANOUT`.
The grouping exists; it is a comment, so salience cannot read it. Promoting
the file's own stated grouping into a field beats inventing a taxonomy.

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
