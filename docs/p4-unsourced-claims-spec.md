# Spec: the unsourced-claim gate

**Status:** proposed, not implemented. Plan-before-code artifact.
**Owner:** RAG session. **Reviewer:** p4 session, before any code.
**Migrations:** none. This is a validator.

## Read this first: this chunk is NOT the fabrication fix

Ten of eleven attacks against the proposed check survive. **It catches roughly
one in eleven of what it targets**, against a non-zero false-positive rate on
the owner's own signed voice — and that trade is the reason this document does
not end in "ship it and note the residual".

The mechanism that solves unsourced world-knowledge is **the commentary depth
gate plus grounding**, both already plan-of-record. This chunk is a narrow
backstop and should be scoped and priced as one. If it merges reading as
"the problem is handled", the document has failed.

**Recommended sequencing changed after review:** ship the depth gate, then
RE-MEASURE the leak, and only then decide whether this is worth building. The
false-positive rate measured today would be calibrated against drafts produced
under the *old* contract — starved payloads reaching outside the record — which
is precisely the population the gate removes. **The number would describe a
distribution we are about to delete.** I applied that discipline to p4-14 and
not to my own primary fix; the reviewer caught the asymmetry.

## The residual, first

**A deterministic check catches the jargon-bearing cases and misses plain
English.** Eleven attacks were written against the proposed design and **ten
survive**:

```
SURVIVES  You can trade an event contract on an official outcome.
          You cannot push the outcome and then trade it.
SURVIVES  Enforcement here follows the outcome. It never shows up while the
          contract is still live.               <- gen #33's claim, reworded
SURVIVES  Polymarket had the same contract open and nobody there paid anything.
SURVIVES  Orders this size usually land on a firm, not a person.
REJECTED  ...the first such order against an individual trader, per CFTC.
```

Three named classes are **not covered at all**, and the argument that they are
not deterministically reachable is the part worth reading:

- **Causal.** A connective bank (`because`, `after`, `once`, `triggered`)
  cannot ship: `"Nobody buys 25,000 shares by accident."` is causal, and it is
  the owner's own signed voice.
- **Analogy.** `"This is insider trading with a ballot box instead of an
  earnings call."` passes, and analogy is the cheapest way to assert an
  **uncharged offence** while appearing figurative. The obvious increment is an
  offence lexicon, and it does not survive contact with
  `"This isn't an enforcement regime, it's a subscription fee for opacity."`
- **Predictive.** `"More of these orders are coming before the midterms."`
  passes.

This is stated first rather than in a footnote because an unstated residual is
how a ticker floor survived three review rounds in this repo.

## Why this is a backstop and not the primary fix

The primary fix is upstream, and it is a **contract** change rather than a
validator: see `docs/verification/2026-08-01-payload-depth.md`.

The commentary variant carries a 200-weighted-character **minimum**. `dry` and
`sharp` carry none — and that is the only relevant difference between them,
since `validateVariant` runs an identical fabrication floor for every variant.
Measured against what each thin source can actually produce:

| source | fact block | floor | must come from elsewhere |
| --- | ---: | ---: | ---: |
| press_cftc_enforcement | 115 | 200 | 85 |
| edgar_form4 | 66 | 200 | 134 |
| sec_schedule13 | 46 | 200 | 154 |

The record runs out around 110 characters and the contract demands 200. The
remaining 85–154 have to come from somewhere, and the only source left is the
model's knowledge of the world. **The drafts are complying with a contract we
wrote.** From the same 5-field payload, `dry` produced `"Order entered."` and
stopped, because nothing pushed it to continue.

91% of items come from sources whose median payload is at or below six fields,
so this is the normal operating condition, not an edge case.

**And the trend is against us.** The ingestion session measured the press
sources they added tonight, taking press from 6 sources to 26. Across 60 items
in the adopted fixtures:

| | share |
| --- | ---: |
| title carries a money figure | **2%** |
| title carries any non-date number | 5% |
| description carries a money figure | 8% |
| description empty | 35% → 20% after a parser fix |

Their conclusion, and it is the one that matters here: **26 of roughly 35
sources now structurally cannot fund a 200-character commentary from their own
record.** The 2% is not a defect to fix — it is what a regulator press feed
*is*.

So the population this gate will run against is getting thinner as coverage
grows, which is the opposite of the direction a validator wants. That is an
argument for the depth gate landing FIRST and for this check being sized
against the post-gate population rather than today's.

**Therefore:** gate the commentary *variant* on whether the record can fund it,
falling back to `dry`/`sharp`. The failure mode becomes "a thin item gets a
wire post" — the archetype's own default — instead of "an unsourceable claim
about a named person is published". Framed correctly, nothing is withheld: we
stop asking for 200 characters we cannot source.

That gate is **not** in this chunk. This chunk is the backstop for items that
clear the depth gate and still reach outside.

## The check

`worldCheck(text, opts): ValidationIssue[]`, three rules:

| rule | licenses | scope |
| --- | --- | --- |
| `world` | domain vocabulary must appear in payload ∪ provenance-verified source ∪ lake context ∪ archetype vocab ∪ eligible beats | **take only** |
| `world_form` | five construction banks: counterfactual, negative-existence, stance, institutional-purpose, superlative | whole text |
| `quote` | any quoted span ≥3 words must be verbatim in the licensed universe | whole text |

### Why imported domain vocabulary, and not "record vs world"

The seed idea — legitimate beats are about *the record*, fabricated ones about
*external reality* — describes the harm correctly and is a broken decision
procedure. `"You'd pay more to park at the airport for a week."` and
`"Event contracts face identical manipulation scrutiny to cash-settled
derivatives."` are both claims about external reality, both clear the current
floor, and one must live while the other dies. No rule on that axis separates
them.

Imported domain vocabulary does separate them, for a reason rather than by
luck: nobody reads a market desk as *informing* them about airport parking, and
everybody reads it as informing them about derivatives scrutiny. **Technical
vocabulary is the signal that the desk switched from opinion to reporting.**

That makes this the third leg of a principle the floor already implements
twice: every NUMBER licensed (`numberCheck`), every PROPER NOUN licensed
(`entityCheck`), now every DOMAIN TERM licensed. Same universe, same
fail-closed direction. It inherits `checkGroundingProvenance` for free — when a
source fails provenance the licensed set shrinks, so a mis-fetched EDGAR index
page *tightens* the check.

### Take-only scope

Whole-text scope was proposed and rejected on measurement: against the live
5-field CFTC payload it rejects exemplar E20 on `commodities`, and the
offending words are `"a physical commodity market"` **in the fact block**. The
fact block is already licensed by `numberCheck` and `entityCheck`; the take is
where imports land.

## The feedback string

This is the load-bearing design decision, and it depends on a mechanism worth
stating: `generate.ts:462` pushes every `issue.detail` into the retry prompt
under `"Fix exactly these and change nothing else:"` (`generate.ts:181`).
**The detail IS the repair instruction.**

So naming the offending token teaches relexicalisation — the model swaps the
word and keeps the claim. The detail must therefore never contain it:

```
unsourced claim in the take: "<sentence>" DELETE this sentence. The take may
only assert what the payload, the source document or the lake context states,
or what this desk thinks about that record.
```

The cheapest compliance with *delete* is deletion, not rewording. That is the
gradient we want.

**But the better answer is not to retry at all.** Under *"Fix exactly these and
change nothing else"*, against a 200-character floor, "remove something, I
won't say what" is close to unfollowable. The model will delete *something* —
plausibly the licensed part — and the retry may then fail a different gate,
burning an attempt to arrive somewhere worse.

So this rule should **reject the variant outright and fall through** to the
next variant or the template, rather than entering the regenerate loop. That
avoids teaching relexicalisation *and* avoids issuing an instruction that
cannot be complied with. The `evidence`-to-telemetry-only design is unchanged.

`quote` is the exception and names the span, because there the correct repair
genuinely is to quote the document or drop the quotation marks.

**Telemetry without teaching:** `ValidationIssue` gains an optional `evidence`
field carrying the offending term. It reaches the log and the digest and never
the feedback. Without it, lexicon drift is invisible.

## Going quiet — the guard

The failure this must not cause is a validator so strict that every commentary
variant dies and the account falls silent, which is indistinguishable from a
broken pipeline.

- Rejection costs one regenerate; the fallback chain already ends at a template
  rather than at nothing.
- **A rising `rejected:world` rate is the canary**, and it needs to be in the
  nightly digest from day one — p4-09a already excludes template fallbacks from
  the zero-edit rate, so a validator driving items to template can no longer
  raise the headline number while doing it.
- If the depth gate lands first, most thin items never request commentary, so
  this check runs on a much smaller and better-funded population.

## Before merge

0. **Re-run the 26/30 fabricated-corpus figure myself.** It is marked as the
   workflow's rather than mine, and it is still doing load-bearing work in the
   argument for building this at all. Labelling an unverified number does not
   make it safe to reason from — it makes the reasoning honestly provisional,
   which is not the same thing.
1. Re-measure the false-positive rate **after** `p4-14` lands. Calibrating
   against exemplars that already fail the existing floor is meaningless.
2. Re-measure once body capture is live — `raw_text` was NULL on all 10,825
   items when this was scoped and moved to 5 within the hour. The trigger is
   stated in data: **re-measure when `raw_text` covers more than 25% of items
   queued in the trailing 7 days.**
3. Ship the parity harness red first, as `p4-14` did, so the baseline is a fact
   rather than a claim.

## Rejected: the LLM judge

Rejected on **wiring**, not doctrine, and the wiring defect was real and
pre-existing — the p4 session confirmed it and fixed it in #96.
`validateVariant` sits outside any try/catch in the variant loop, so a judge
timeout escapes `runGeneration`, never advances `attempt` (so `MAX_ATTEMPTS`
never binds), and takes `deliverCards` down with it because `jobs.ts` awaits
them in sequence — stranding commentary already written and accepted on
previous ticks.

It also breaks the overlap invariant: `RUN_TIME_CAP_MS` gates only the *start*
of a row, so three judge calls per round at 15 s each push a row past the
300 s cadence and two invocations land on one row.

**Worth revisiting after #96**, since a judge on a fixed path is a genuinely
different proposition from a judge on a path that takes delivery down with it.

## Provenance of this document

Produced by a design workflow (4 characterisation lenses, 3 independent
strategies, 3 adversarial judges, 1 synthesis). Every claim about this
codebase that the document relies on was re-verified by hand before being
written here — the `entityCheck` findings became `p4-14`, and the
`deliverCards` coupling was confirmed by the p4 session and fixed in #96.
Measurements attributed to the workflow that have **not** been independently
re-run are marked as such: the 26/30 fabricated-corpus figure, the 8 ms CPU
figure, and the 10-of-11 bypass count are the workflow's, not mine.
