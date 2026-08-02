# Six defects in one evening, none of which errored

**Written 2026-08-01**, from work across three concurrent sessions (ingestion,
p4/ops, generation). Filed in `verification/` rather than as a design doc
because every claim below is a measurement someone took, and the numbers are
the point.

> **Corrected 2026-08-01 after review.** The first version of this document
> contained five factual errors, which is worth recording rather than quietly
> fixing: a retrospective about checks that appear to have run and did not is
> exactly the document that must not assert unverified things. Each correction
> below is marked where it lands. Found by the p4 session reviewing it properly
> after it had already been merged as "doc-only, zero-risk".
>
> Read the second way on purpose: a document about signals that report success
> while being wrong, which itself shipped five wrong assertions behind a green
> review, is the cheapest available demonstration of its own thesis. The
> instructive part is not that it happened but *where* — in the PR whose
> framing ("doc-only, zero-risk") is precisely the one that skips scrutiny.
>
> **This document required three passes.** The first shipped five wrong
> assertions; the second corrected them and introduced a sixth (a timeline
> claim in the very correction that removed an unsupported test count); the
> third is this one. Each error was found by a reader with no stake in the
> text, never by its author rereading it. That is the document's own thesis
> applied to the document, and the count is left visible on purpose — a
> retrospective claiming to be clean would be the least credible artifact in
> the repository.

## The finding

Six independent defects were found in production behaviour on 2026-08-01.
**Not one of them threw an error, failed a test, or turned a check red.** Every
one reported success while meaning something else.

| # | What reported success | What was actually true |
|---|---|---|
| 1 | The corpus-echo check contributed no issues to any draft | *(Correction 1 of 5.)* It was **never called**: `validateVariant` gates it on `corpusPopulated`, and `echo_ngrams` held **0 rows** since 07-28. A check that silently declined to run |
| 2 | The issuer gate suppressed a filing with reason `not_in_reference` | `issuerCik` had failed to **parse**. "Absent from the reference" and `not_listed` (present, empty exchange) are different outcomes; a failed lookup was read as a fact about the market |
| 3 | `jobs.consecutive_failures` read **0 across all 39 enabled jobs** | `treasury_auction` had **16** source failures and `src_last_ok = never` — and its job row stamped `last_ok_at = today` |
| 4 | An 8-K grounding fetch returned HTTP 200, non-empty | 2,077 chars of EDGAR **navigation chrome and a GTM snippet**, not the filing |
| 5 | A press-release fetch returned 200, 106,641 chars | A **PDF**, tag-stripped into object tables; `/Prev 223302` entered the fact whitelist |
| 6 | A short grounding text passed the prose gate | A **spreadsheet**: ~10 tokens, because binary has no spaces, so it fell under a 20-token exemption |

**#3 is the purest of the six**, and worth separating. The others were side
effects — a fetch that happened to return 200, a table that happened to be
empty. `consecutive_failures` is a **dedicated health signal**, built to answer
exactly the question it got wrong. It only increments when a handler *throws*,
and every polling ingester catches its own fetch error and returns normally, so
the dispatcher then records a successful run. A source that has never once
succeeded reports zero failures and a success timestamp from today.

*(Correction 4 of 5.)* Its companion, found **2026-07-28** (PR #63), not the same evening:
`issuer_refresh` and `fda_food_recall` had **never executed at all**, because the tick's time budget broke the loop at the same
place every time. `enabled = 1`, zero failures, no errors, never ran. **A job
that never runs looks identical to a job with nothing to do.**

## The two shapes, and why they take different fixes

All six are "reported success while meaning something else", but they split
cleanly in half, and a reader who applies the wrong fix gets nowhere.

**Shape A — absence read as a finding.** (#1 empty table, #2 unparsed CIK,
#3 no exception.) The data wasn't there, and its absence was taken as
information about the world. *(Correction 2 of 5 applies here too: the
conclusion drawn was `not_in_reference`, not `not_listed` — the latter means
the issuer is present with an empty exchange.)*

*Fix: a coverage precondition.* Draw a negative inference only when the
reference is complete enough to support one. The issuer gate is the model — it
concludes "not listed" only when its table holds ≥5,000 rows and was refreshed
within 7 days, and otherwise degrades to passing filings through. Reading a
failed refresh as "nothing is listed" would have silenced an entire source at
once, a far worse failure than the one being fixed.

**Shape B — wrong content read as right content.** (#4 chrome, #5 PDF,
#6 spreadsheet.) The fetch entirely succeeded and the reference was fully
loaded. No precondition helps, because nothing was missing.

*Fix: verify the content is what it claims to be.* This is where
`checkGroundingProvenance` (does this text carry an anchor the payload also
carries?), `looksLikeProse` (is this text, or a document's internals?) and
`looksBinary` (did the decode already fail?) live. Note that these are
**complementary, not redundant** — an SEC litigation PDF carries
`/Title (In the Matter of <RESPONDENT>)`, so the anchor test passes on it and
only the prose test refuses it.

## A third class: correct, and ruinous

Both shapes above eventually produce a wrong answer, which some assertion can
eventually catch. This one produces the **correct** answer, forever, and no
output-based test can see it.

`issuerGate` called `referenceHealth` once per filing. The query is
`SELECT COUNT(*) AS rows, MAX(updated_at) FROM issuers` — and `MAX` over an
unindexed column means D1 scans the table. **Measured against production:
8,043 rows read per call**, versus 1 for the primary-key lookup sitting beside
it. At the three lanes' real cadences the ingestion session put this in the
tens of millions of rows per day against a documented 5M/day cap — exhausted in
minutes. And because the jobs table, the dedup ledger and the approval queue
are all D1, the consequence is not three degraded sources but **every query
failing**.

Every answer it returned was correct. Every test passed.

This is neither shape A nor shape B. It is **correct behaviour at a ruinous
price**, and the only instrument that shows it is a cost meter.

**We have no such instrument.** Verified — none of these appears anywhere in
`src/` or `test/` on main:

- `meta.rows_read` assertions on hot-path queries
- an `EXPLAIN QUERY PLAN` check that no per-item query reports `SCAN`
- a per-tick D1 budget counter

It was caught because a reviewer went looking, not because anything failed.
Recorded so the absence is a **known gap rather than an assumed cover**.

**The fix was structural, and the sequence matters more than the fix.** The 8-K
lane had already hoisted this call, with a comment saying to. The comment was
read, understood, and the bug was reintroduced in three lanes anyway — a
comment doing the only thing a comment can do, which is *ask*. `issuerGate` now
takes a `GateContext` built once per batch, so the expensive read cannot be
reached from a per-filing call site at all. **A signature that cannot express
the mistake removes the asking.**

## The rule that follows

**Assert the outcome, not the edit.**

Hard-asserting that a patch anchor matched proves the edit landed somewhere. It
says nothing about whether the resulting behaviour is right — and an anchor can
match while the replacement is subtly wrong. What proves something is a probe of
the real system, after the change, phrased as the claim you actually care about.

Three worked examples from the evening:

- Loading 726,579 hashes was not verified by "146 commands succeeded". It was
  verified by querying production with **three 8-grams from a real corpus post
  (3 of 3 present)** and **three from an owner exemplar (0 of 3 present)**.
- The binary-gate fix was not verified by a passing test. It was verified by
  re-running the *original failing probe* against the shipped code: 10 tokens,
  exemption would have said prose, guard now returns false, terse context line
  still true.
- PRs merging cleanly was not verified by MERGEABLE flags — that flag compares
  each branch to main *as it is now*, and says nothing about branch B after
  branch A lands. It was verified by merging the open heads into a throwaway
  worktree and running the combined suite (reported: typecheck clean, migrations
  sequential, suite green).

  **With a boundary worth stating, because it is the lesson.** *(Correction 3
  of 5, twice: the original quoted a test count the check could not support,
  and the first correction replaced it with a timeline claim that is also
  wrong — the result was already recorded at 20:36:39Z, before the main-branch
  state the text attributed it to.)* What is actually supportable: the check
  covered **nine of the eleven** PRs open at the time, and its result is not
  reproducible today because branches moved under it. A verification is only as
  wide as the set it was pointed at, and only as current as the moment it ran.
  Quoting its number afterwards extends a real check past its evidence — which
  is this document committing a variant of its own subject, twice.

## The property underneath, named 2026-08-02

*Added a day later, after the same shape appeared six more times across three
sessions in a single night. "Assert the outcome, not the edit" is a special
case of it.*

> **The reporter and the worker are different processes, and the reporter's
> success is evidence about the reporter.**

Every defect in this document, and every one below, is an instance. Filed as
separate lessons, the next arrives and gets filed as another separate lesson.
Filed as one property, it is recognised on sight.

### The surfaces, 2026-08-01 into 2026-08-02

| surface | reported | true |
|---|---|---|
| A shell pipeline printed `typecheck OK` | exit 0 from `echo` | `tsc` had failed; the exit code belonged to the last command in the pipe |
| A test count of 770 | vitest's summary | included three subagent scratch files swept in by `git add -A`, none of them read |
| `zzRefuteScratch.test.ts`, on main four days | two passing tests | **zero `expect()` calls** — it could not fail, and was counted green in every total three sessions quoted |
| A test named "commentary has a 200 weighted floor" | green | the 200 floor had been deleted; the fixture still failed the new 75, so a correct assertion outlived its own premise |
| A PR check | green | measured against a base that no longer existed; green about a tree nobody would merge |
| A heredoc commit message | exit 0 | backtick expansion silently deleted three identifiers mid-sentence |
| A CPSC source probe | clean JSON, rich record | `Manufacturers` empty on **31 of 40**; the unit count absent from **all 40** — and the word "units" absent entirely |
| A press-source probe | "usable" | three were endpoints already being polled — **two under identical URLs, one differing only by a query parameter** — it answered *is this reachable*, not *is this new* |

The last two are the ingestion session's; the assertion-free test file and its
four-day green are theirs too, found by auditing their own history rather than
by anything failing.

### Three more, where the check ON THE CHECK failed

| surface | reported | true |
|---|---|---|
| A reviewer reproduced an author's distribution and confirmed every figure | the arithmetic checked out | it was computed over the wrong **population** — 20 of 27 exemplars belonged to a register the rule did not govern. **Reproducing a number confirms the arithmetic and says nothing about the population** |
| A mutation came back green | the guard is missing | the guard was fine and **the mutation was a no-op** — a comment inserted where a real change should have been. Seen repeatedly — a no-op comment where a real change belonged, and a shell loop that split its own mutation strings on an embedded colon |
| A cross-session finding arrived contradicting a correct local measurement | the local measurement was wrong | the *incoming* one was, and the recipient moved to retract a good document without re-measuring. It came from the session that had spent the night insisting on provenance marking |

**The mutation row deserves its sign stated**, because the natural reading is
wrong in both directions. One instance was a passing mutation hiding a defence
that lived somewhere other than where the author assumed — coverage that
existed, misattributed. Others were passing mutations hiding **nothing at
all** — a gap invented where none existed.

**But the property bites one step earlier than "the mutation test lied", and
the difference changes what you do about it.** A green mutation run reports one
bit for a conjunction of two claims: *the code changed* and *a test noticed*.
Green cannot say which conjunct failed. That is under-determination, and
nothing in it involves a success signal produced by a different process than
the work.

The genuine instance is the **mutation-application step**. `sed` exits 0
whether or not it matched. Python's `str.replace` no-ops silently on a missing
anchor — already in the adjacent-instances list below, as a patch script that
printed `polish applied` having changed nothing. A shell loop that split its
mutation strings on an embedded colon exits 0 having applied garbage. *That* is
a reporter reporting success while the worker did nothing.

So: **the diff is not a double-check on a test you already half-trust. It is
what makes the run's output mean anything at all.** Without it, green is not a
weak signal — it is not a signal. Put each mutation's diff in the commit
message, including the one expected to stay green.

Which places it precisely: a no-op mutation is not a new species, it is **row 1
one level up.** The corpus-echo check silently declined to run; a mutation that
never mutated is the check-on-the-check silently declining to run. Same defect,
same invisibility, different altitude.

**All three are the defence failing**, which is why they are separated rather
than appended. The conclusion below is *"the only defence is a check performed
by something other than the reporter"* — and these are three checks-on-checks
doing exactly that and still reporting wrongly. A reader who reaches that
conclusion should meet its counter-examples immediately.

And they share a shape: a reviewer confirmed an **arithmetic** and never asked
what it was computed over; a mutation run confirmed an **exit code** and never
asked what it was applied to. **Both verified the operation and not the
operand.**

The cleanest instance has no second party at all. The CPSC row's author
confirmed a **count** and never asked what it was counted over — no reviewer,
no cross-session hand-off, no tooling between the claim and the claimant, just
a date filter never written. Where the other two need someone to hand the
operand over, this one only needs you to stop looking at it.

**The cross-session row is the coordination form**, and it is the one with no
technical fix. Everything three sessions sent each other all night was a
*summary*, and a summary is a number produced by a process the reader did not
run. The rule that survives it: **a cross-session finding that contradicts your
own measurement is a reason to re-measure, not to retract** — which does not
depend on the sender remembering to attach caveats, and is therefore cheaper
than asking everyone to be careful.

**Provenance, since this document's own subject demands it.** Rows 1–6 are
this session's and each was reproduced here. Rows 7–8 are the ingestion
session's. They were first written as *reported, not re-run* — and marking them
that way is the only reason they were checked, because the author then went and
re-measured both.

**Both were wrong, in opposite directions.** The CPSC denominator was 55, drawn
from "July onward with no end date", which swept in August items under a July
label — a real count of the wrong set. Corrected to 40, which moves the empty-
manufacturer share from 60% to **78%** and makes the row stronger than claimed.
The press row said "identical URLs"; one of the three differed by a query
parameter.

**And correcting the second found a live defect.** The duplicate-URL guard
written in response to that probe used exact string equality, so it would have
caught two of the three cases it existed for. The author had found three
sources by eye, described them as "identical URLs", and encoded **the
description** rather than the class — and it stayed green because the config
happened to be correct. Fixed to compare host and path with the query
discarded. Row 3 is theirs
but was verified here before being written down: `git show d089bab` gives **0
`expect(` and 2 `it(` blocks**, added 2026-07-28 and removed 2026-08-01 in #97,
which is four days on main.

### A sibling, deliberately NOT in either table

One surface from the same nights does not belong under this property, and
saying why is more useful than filing it anyway.

A budget test failed on CI three times. The cause was neither of the two
suspects: `TICK_TIME_BUDGET_MS` is **1**, and workerd's clock granularity is
also **~1 ms**.

```
PROBE job=budgetjob0 ran=0 elapsed=1.000 budget=1
PROBE job=budgetjob2 ran=2 elapsed=5.000 budget=1   <- defers
```

Where `elapsed` reads `1.000` the guard trips; where it reads `0.000`,
`0 >= 1` is false and more jobs start. **The threshold was set at the
resolution of the instrument measuring it** — the measurement was fine and the
*comparison* was below the noise floor.

Every row above is a reporter reporting something untrue. **Here nothing lied.**
`elapsed` genuinely was `1.000`, and genuinely was `0.000` elsewhere, and
neither reading is wrong. The report is accurate and the *decision built on it*
carries no information.

So it is a sibling property rather than an instance: **a threshold placed
inside its own instrument's error bar.** Filing it in the table would dilute a
property whose whole value is that it names one mechanism precisely.

**And the tidy version of it is half the story**, which is its own lesson. The
same assertion was false for a second, independent reason: a runner that
returns before its counter increments — a lost claim, or a row with no
registered handler — lets the next item re-check against a stale count. Four
handler-less rows seeded ahead of the real ones put six items past a guard
sized for two. Either reason alone makes the test flaky. "The clock was the
problem" is the satisfying answer and it is 50% of one.

### The shape survives the fix, which is why the fixes kept failing

Stated because three separate sequences here have it, from three sessions:

> Each fix corrected the previous one's surface and kept its shape, and the
> shape was the problem.

- A budget assertion rewritten three times — a hardcoded bound, then
  read-the-value-back, then a property independent of timing. The first two
  kept asserting **a count that several unrelated things can move**.
- A duplicate-URL guard that encoded *the description of the three sources
  found by eye* rather than the property, and stayed green because the config
  happened to be correct.
- A name/date boundary rewritten three times: borrow the vocabulary, then
  borrow the shape, then finally borrow the predicate. The first two were
  approximations of a boundary, and an approximation of a boundary is a hole on
  both sides of it.

The tell is the same each time: the fix addresses the failing case and leaves
the class. **A fix scoped to the instance that revealed the class is the
default failure** — it takes deliberate effort to notice, because the instance
is always the thing in front of you.

### Why knowing about it does not help

The clearest evidence is the sixth surface, which was produced **while writing
about the property**: a shell variable interpolating to nothing inside a
heredoc that exited 0, caught only by re-reading the commit, and then needing a
second re-read to confirm the amendment had landed.

So the conclusion is not vigilance. It is structural:

**The only defence is a check performed by something other than the reporter.**

Worked instances from the same night, each cheap:

- **Mutation testing** rather than a green suite — it answers *is this test
  load-bearing*. With the caveat that it answers only that: one mutation here
  passed because it had been aimed at the wrong line, and the guarantee was
  real but living somewhere else. **When a mutation passes, "I mutated the
  wrong line" is a hypothesis before "the guarantee is missing"** — they have
  opposite fixes, and stopping at the first gives a false all-clear.
- **Reading the figure out of the run log into a variable** rather than
  recalling it. Two commit messages carried a count from the wrong branch
  before this was adopted.
- **Reviewing a pinned SHA**, stated explicitly, with the author freezing the
  branch until a verdict returns. `#106` moved under a running review three
  times; each move invalidated a running review — one was killed mid-flight and
  a second required a scoped delta pass to cover what it had missed. A review is
  a measurement of a tree, and **the tree is a variable the author controls**,
  which makes the freeze the author's obligation rather than the reviewer's.
- **Enumerating the class, not the instance** — but only where the change makes
  a validator *accept* something it used to reject. Everywhere else it is a tax
  nobody pays, and an unaffordable discipline is one that quietly stops.

### A related rule, from the same evidence

**When a new test fails, the code is not the leading hypothesis.**

Four of five times on 2026-08-02, a red new test meant the *assertion* was
wrong: a matrix asserting one validator must catch every separator when
another legitimately owns three of them; a count of every message sent rather
than the one under test; two fixtures too weak to license their own inputs.

A new test encodes a fresh belief about the system, and a fresh belief is more
likely to be wrong than code that has been running. The danger is not the
frequency but the reflex: the natural response to a red new test is to change
the code until it goes green, **which is how a correct implementation gets bent
to match a wrong assertion** — after which the wrongness is documented as
intentional by a passing test.

## How they were found

**Four of the six were found by measuring something we already believed, not by
hunting bugs.** Nobody went looking for #1, #4, #5 or #6. Each surfaced when
someone checked a number they expected to be boring:

- "is the echo table populated?" → 0 rows
- "what did that fetch actually return?" → chrome
- "which of these six feeds ship a body?" → three don't, two link to PDFs
- "does my gate catch the class you just found?" → no

### And in every case the finder had no stake in the subsystem

Sharper than "measure what you believe", because it names a practice rather
than an attitude. Three sessions worked this codebase concurrently, and each
serious defect was found by whichever one did **not** own the code:

| defect | found by | while doing |
|---|---|---|
| empty `echo_ngrams` (generation) | ingestion | asking about the **issuer gate** |
| per-filing D1 table scan (ingestion) | p4/ops | reviewing a **filing gate**, not performance |
| PDF licensing facts (grounding) | ingestion | measuring **press-feed thinness** |
| provenance gate mostly fail-open | p4/ops | reviewing a PR that **claimed a defect in their own work** |

Nobody was auditing. Each was doing ordinary adjacent work and looked one layer
sideways. That is far cheaper to institutionalise than "review harder": it
requires only that the layers keep telling each other what they actually
observe.

The uncomfortable corollary is the reason it works. **All three sessions
reviewed their own work carefully and all three shipped a critical defect
anyway** — not for want of rigour. One hard-asserted every patch anchor and
still shipped a per-filing table scan; another wrote a provenance gate and
missed that it fail-opened for half the pipeline. The blind spot is structural,
not attitudinal, so no amount of self-discipline reaches it. The only
instrument that did was a reader with different priors.

## The one where a guard created the gap

#6 is the only case where a **present, well-reasoned check** opened the hole
rather than missing it. The 20-token exemption was *correct in isolation*: a
word-ratio over a handful of tokens is noise, and lake-context lines are
legitimately terse. It became a hole only when a class arrived that is short
*because it is not text*.

**Short text is only trustworthy if it is text.** A scope exemption needs its own
precondition, or it is an unexamined edge waiting for the right input.

## A measurement discipline that held twice

Link density looked like a signal for separating index pages from articles on
an initial two-sample look. It was **declined at n=2** for insufficient margin,
then **killed outright at n=17** *(the n=17 figures below are the recorded
ones; the two-sample pair is not in any verification record and is omitted
rather than restated)*: the values run continuous from 0.41 to
0.71 with no gap, and the high end is genuine releases (Tankan, Monetary Base)
scoring high precisely because they link to their data rather than inlining it.
*(Correction 5 of 5.)* A 0.55 cut rejects the IMES listing at 0.63 — and rejects Tankan and Monetary
Base too, because at 0.70 and 0.71 the genuine releases score **higher** than
the listing does. That inversion, not the margin, is the point: no monotonic
threshold can separate them, because the metric ranks some real documents above
the junk it is meant to catch.

Not a threshold problem. The metric measures the wrong thing. Per-host
extraction selectors are the honest fix.

## Adjacent instances, same shape, not shipped defects

These cost real time on the same day but are tooling or reporting rather than
behaviour that reached production. Listed separately so the count above stays
honest.

- A patch script printed `polish applied` while changing **nothing** — Python
  `str.replace` silently no-ops on a missing anchor.
- `index.json` reports document `type` as an **icon filename** (`"text.gif"` for
  every entry) — a field that looks like type and is not.
- `wrangler d1 migrations apply` prints **"No migrations to apply!"** identically
  for "nothing pending" and "your checkout doesn't contain the file". It bit the
  owner twice and a session once.
- A `.bin.fixture` extension fails `?raw` at **module resolution**, not at read.
- Literal control bytes inside committed fixtures are **invisible in every
  diff**, and made exact-match editing fail against the file. (The harness later
  rejected a command for the same reason while this document was being written.)

## For whoever picks this up

Before trusting any green signal, ask what question it actually answers. All six
above answered a real question correctly — it just wasn't the question being
asked of them.
