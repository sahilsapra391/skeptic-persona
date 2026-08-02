# How thin our payloads actually are

**Date:** 2026-08-01
**Why measured:** the drafts that imported unsourced world-knowledge came from
a 5-field CFTC payload. Before designing a validator, I wanted to know whether
that payload was an outlier or the norm, because the answer decides whether a
depth GATE is a viable fix or a way to silence the account.

## Method

2,000 most recent `items` rows in states `queued`/`posted`/`logged`, from the
live `skeptic-wire` D1. Depth = count of top-level payload keys with a
non-empty value (`null`, `""`, `[]`, `{}` excluded), which is the same
definition `pairContext()` records on every posted draft.

## Result

| source | items | median fields | min |
| --- | ---: | ---: | ---: |
| edgar_reconcile | 1 | 3 | 3 |
| press_cftc_enforcement | 9 | 4 | 4 |
| press_boj | 6 | 4 | 4 |
| **edgar_form4** | **1,503** | **4** | 4 |
| rate_boe / rate_ecb / rate_bcb | 3 | 5 | 5 |
| sec_schedule13 | 182 | 5 | 5 |
| edgar_8k | 130 | 5 | 5 |
| halt | 67 | 8 | 7 |
| noaa_storms | 3 | 10 | 10 |
| cftc_cot | 5 | 11 | 11 |
| house_ptr | 2 | 15 | 15 |
| treasury_auction | 12 | 16 | 7 |
| sec_form144 | 77 | 20 | 20 |

**Nine of fifteen sources sit at or below six fields, and those sources are
1,834 of the 2,000 items — 91%.**

`edgar_form4` alone is 1,503 items at a median of four fields.

## What this rules out

**A payload-depth gate cannot be the primary fix.** Refusing to generate
commentary below the depth that produced the bad drafts would silence roughly
nine items in ten. That is the "account goes quiet" failure mode, and it is
indistinguishable from a broken pipeline — the same reason the validator must
not be so blunt that real commentary dies.

So the thinness is not an anomaly to gate against. **It is the normal operating
condition**, and the validator has to work under it.

## What this reframes

The pressure is structural, not incidental. A model given four fields and asked
for an opinionated take has almost nothing in the record to be opinionated
about, so it reaches outside the record. Unsourced world-knowledge is the
predictable consequence of thin payloads meeting a commentary contract, not a
random model failure.

That points at grounding rather than gating: of 10,825 `items` rows, **5 carry
`raw_text`** — and that number was **0 about an hour earlier the same evening**.
The 8-K body capture (#75) and House body capture (p4-07) are landing in
another session as this is written, so essentially every draft generated so far
has been produced from payload alone.

A validator designed against today's depth must therefore be re-checked once
bodies land, because the licensed universe it tests against gets much larger.
The same rule can go from strict to lenient with nobody editing it — the
measurement moved under this document while it was being written, which is the
concrete version of that warning rather than a hypothetical one.

## The mechanism: the commentary floor is a forcing function

Added after the p4 session pushed back on the framing above. They argued a
depth gate does not mean silence, because `dry` and `sharp` are the honest
output for a thin item and commentary is the escalation tier, not the
baseline. That is right, but their stated reason — that dry and sharp are
"fact-only by construction" — is not what the code does. Checked:
`validateVariant` runs an **identical** Group 1 floor for every variant.
Exactly two things differ by variant:

| | dry / sharp | commentary |
| --- | --- | --- |
| `structuralCheck` max segments | 2 | 3 |
| `lengthCheck` minimum | none | **200 weighted** |

Nothing stops a `dry` variant containing world-knowledge. What stops it is
that it is under no pressure to keep talking.

**The 200-character minimum is the forcing function.** Measured against the
fact block each thin source can actually produce:

| source | fact block | floor | must come from elsewhere |
| --- | ---: | ---: | ---: |
| press_cftc_enforcement (5 fields) | 115 | 200 | **85** |
| sec_form144 (20 fields) | 98 | 200 | **102** |
| edgar_form4 (4 fields) | 66 | 200 | **134** |
| edgar_8k (5 fields) | 57 | 200 | **143** |
| sec_schedule13 (5 fields) | 46 | 200 | **154** |

The model is handed a record that runs out at ~110 characters and a contract
demanding 200. The remaining 85–154 characters have to come from somewhere, and
the only remaining source is the model's own knowledge of the world.

This is not a model quirk to be validated away. **It is a contract we wrote**,
and the drafts are complying with it. `dry` produced "Order entered." from the
same payload and stopped, because nothing was pushing it to continue.

That makes the gate measurable per item and BEFORE generation: compare the
available record (fact block + grounding) against the floor, and offer
commentary only where the record can actually fund it. The failure mode
becomes "a thin item gets a wire post" — the archetype's own default — rather
than "an unsourceable claim about a named person is published".

## Re-check trigger, not a date

Every threshold here is calibrated against a distribution the rest of the
project is actively changing, so it has an expiry nobody sets. Stating the
trigger in data instead of a calendar:

> **Re-measure when `items.raw_text` is non-NULL for more than 25% of items
> queued in the trailing 7 days.** At that point the fact-block table above is
> stale, because grounding rather than payload becomes the binding input.

## Caveat on scope

This counts TOP-LEVEL keys only. A payload with one deeply nested object scores
low while carrying plenty of fact. None of the thin sources here are shaped that
way — spot-checked `edgar_form4` and `press_cftc_enforcement`, both flat — but a
future source could be, and the metric would understate it.
