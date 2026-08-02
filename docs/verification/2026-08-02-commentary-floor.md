# The commentary floor was the forcing function

**Date:** 2026-08-02
**Chunk:** p4-18
**Claim under test:** that a flat 200-weighted-character minimum on the
commentary variant is what pushes the model outside the record.

## Why a floor at all

`validateVariant` runs an **identical** fabrication floor for every variant.
Exactly two things differ:

| | dry / sharp | commentary |
| --- | --- | --- |
| `structuralCheck` max segments | 2 | 3 |
| `lengthCheck` minimum | none | **200 weighted** |

Nothing stops a `dry` variant carrying world-knowledge. What stops it is that
nothing pressures it to keep talking. From the same 5-field CFTC payload that
produced *"Event contracts face identical manipulation scrutiny to
cash-settled derivatives"*, `dry` produced **"Order entered."** and stopped.

## Measurement 1 — what the record can actually say

400 most recent `queue` rows joined to their items, weighted length of the
rendered wire draft's fact block:

| archetype | n | median | min | max |
| --- | ---: | ---: | ---: | ---: |
| HALT | 102 | 86 | 36 | 204 |
| INSIDER_NOTICE | 75 | 174 | 109 | 252 |
| FILING_FORM4 | 62 | 142 | 92 | 202 |
| FILING_8K | 62 | 190 | 76 | 277 |
| OWNERSHIP_STAKE | 50 | 122 | 56 | 196 |
| REGULATORY_NEWS | 22 | 148 | 86 | 239 |
| INSIDER_CLUSTER | 3 | 263 | 259 | 264 |

**Only 17% of rows can fund a 200-character commentary from their own record.**
For the rest the model must find a median of **74** characters elsewhere, up to
164.

## Measurement 2 — what the owner's own voice costs

Across all 27 `OWNER_EXEMPLARS`:

| | min | median | max |
| --- | ---: | ---: | ---: |
| fact block | 47 | 86 | 123 |
| **take** | **75** | 124 | 271 |
| total | 126 | 215 | 354 |

Two things fall out.

**His fact blocks are 47–123 — the same range as our live wire drafts.** Record
thinness is not unusual; it is the material he writes from.

**11 of his 27 exemplars are UNDER 200 weighted.** The flat floor was rejecting
41% of the voice it exists to enforce.

## The rule

```
commentaryFloor(templateDraft) = weighted(factBlockOf(templateDraft)) + 75
```

75 is not a chosen threshold. It is the shortest take the owner has ever
signed off, so any higher number rejects text he has written.

The floor reads the **template draft**, not the model's own fact block, so a
model cannot lower its own bar by writing less. Pinned by a test.

### And one genuine withholding, which is arithmetic

When `factBlock + 75 > 280`, no commentary can exist inside the platform limit.
Asking for one can only produce something that fails, or something that made
room by cutting the record. Those items get `dry` and `sharp` — no minimum, and
the archetype's own default.

## Measurement 3 — the effect

Against the same 400 live rows:

| | rows | share |
| --- | ---: | ---: |
| commentary withheld (arithmetically impossible) | 6 | **1%** |
| floor lowered to what the record supports | 245 | **61%** |
| unchanged (record already funds 200) | 149 | 38% |

And the owner's exemplars against the floor they would be judged by:

| | fails |
| --- | ---: |
| flat 200 floor | **11 of 27** |
| record-relative floor | **0 of 27** |

**The 0 is TAUTOLOGICAL and should not be read as validation.** `total = fact +
take + separators`, so `total >= fact + 75` holds whenever `take >= 75`, and
anchoring on the observed minimum guarantees the result. Stating it plainly
because the number looks like a finding and is arithmetic. Raised in review;
the argument below is what replaces it.

### What actually defends the anchor

The sorted takes:

```
75, 78, 86, 92, 97, 105, 106, 108, 108, 109, 111, 117, 122, ...
```

**The bottom of the distribution is dense.** The next value after 75 is 78 and
the one after is 86, so the minimum and the 10th percentile are 11 characters
apart and the choice between them barely matters. Had the takes been
`[75, 120, 124, ...]`, anchoring on 75 would be fitting to a single freak
sample and the percentile argument would win. They are not, so this is an
empirical defence rather than a preference.

**The drift risk is the real hazard, and it is guarded.** `MIN_TAKE_WEIGHTED`
is a literal that happens to equal the data today. A future exemplar with a
60-character take makes the parity test fail — correctly — and the tempting fix
is to lower the constant, which ratchets the floor down permanently, one
exemplar at a time. `test/takeAnchors.test.ts` asserts the constant IS the
computed minimum, so lowering it is a decision someone makes on purpose.

### And the floor is a boundary, not a target

Models satisfice. Told a range starting at 75, output converges just past 75,
and the median draft lands ~40% below the median of the voice it imitates —
every one of them passing, the validator working perfectly, and the posts
thinner than his. That is the original complaint arriving through a new door.

Raising the floor is the wrong answer, since 124 would reject 11 signed
exemplars. So the prompt states **two different quantities**: the CONTRACT
(`commentaryFloor()`, what gets rejected) and the TARGET
(`TARGET_TAKE_WEIGHTED = 124`, his median, what good looks like), labelled so
the target can never be read as the boundary.

This does not contradict "a number stated to the model and a number enforced
against it must come from one function" — that rule is about the contract
boundary, and it still holds. One contract plus one target is a different shape
from three statements of one contract.

## What else had to change

The style pack told the model *"never shrinks commentary below its 200-280
contract"* and `buildPrompt` stated `200-280` directly. Both now read the same
`commentaryFloor()` the validator applies.

That mismatch is the defect class this whole track keeps finding: the first
live OpenRouter call died five times because the prompt taught one attribution
and the archetype declared another. **A number stated to the model and a
number enforced against it must come from one function**, or they drift and the
drift is invisible until something fails five times.

## What this does NOT do

It does not stop unsourced world-knowledge. It removes the *pressure* that
produced it. A model with room to write a short take can still choose to write
a wrong one, and the p4-17 spec covers that as a separate, narrower backstop —
one whose own measurement said 10 of 11 attacks survive.

**Re-measure trigger:** when `items.raw_text` covers more than 25% of items
queued in the trailing 7 days. Grounding raises what the record can fund, so
the fact-block table above is the binding input only while bodies are rare.
