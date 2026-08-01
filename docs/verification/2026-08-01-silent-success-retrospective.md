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

## The finding

Six independent defects were found in production behaviour on 2026-08-01.
**Not one of them threw an error, failed a test, or turned a check red.** Every
one reported success while meaning something else.

| # | What reported success | What was actually true |
|---|---|---|
| 1 | The corpus-echo check contributed no issues to any draft | It was **never called**: `validateVariant` gates it on `corpusPopulated`, and `echo_ngrams` held **0 rows** since 07-28. A check that silently declined to run |
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

Its companion, found **2026-07-28** (PR #63) rather than the same evening:
`issuer_refresh` and `fda_food_recall` had **never executed at all**, because the tick's time budget broke the loop at the same
place every time. `enabled = 1`, zero failures, no errors, never ran. **A job
that never runs looks identical to a job with nothing to do.**

## The two shapes, and why they take different fixes

All six are "reported success while meaning something else", but they split
cleanly in half, and a reader who applies the wrong fix gets nowhere.

**Shape A — absence read as a finding.** (#1 empty table, #2 unparsed CIK,
#3 no exception.) The data wasn't there, and its absence was taken as
information about the world.

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

## The rule that follows

**Assert the outcome, not the edit.**

Hard-asserting that a patch anchor matched proves the edit landed somewhere. It
says nothing about whether the resulting behaviour is right — and an anchor can
match while the replacement is subtly wrong. What proves something is a probe of
the real system, after the change, phrased as the claim you actually care about.

Three worked examples from the evening:

- Loading 726,579 hashes was not verified by "146 commands succeeded". It was
  verified by querying production for a corpus 8-gram (**hit 3 of 3**) and an
  owner-exemplar 8-gram (**hit 0 of 3**).
- The binary-gate fix was not verified by a passing test. It was verified by
  re-running the *original failing probe* against the shipped code: 10 tokens,
  exemption would have said prose, guard now returns false, terse context line
  still true.
- PRs merging cleanly was not verified by MERGEABLE flags — that flag compares
  each branch to main *as it is now*, and says nothing about branch B after
  branch A lands. It was verified by merging the open heads into a throwaway
  worktree and running the combined suite (reported: typecheck clean, migrations
  sequential, suite green).

  **With a boundary worth stating, because it is the lesson:** that check
  covered **nine of the eleven** PRs open at the time, and its result is not
  reproducible from `main@4d40e41` with today's heads — branches moved under it.
  A verification is only as wide as the set it was pointed at, and only as
  current as the moment it ran. Quoting its number later, as this document
  originally did, extends a real check past its evidence.

## How they were found

**Four of the six were found by measuring something we already believed, not by
hunting bugs.** Nobody went looking for #1, #4, #5 or #6. Each surfaced when
someone checked a number they expected to be boring:

- "is the echo table populated?" → 0 rows
- "what did that fetch actually return?" → chrome
- "which of these six feeds ship a body?" → three don't, two link to PDFs
- "does my gate catch the class you just found?" → no

## The one where a guard created the gap

#6 is the only case where a **present, well-reasoned check** opened the hole
rather than missing it. The 20-token exemption was *correct in isolation*: a
word-ratio over a handful of tokens is noise, and lake-context lines are
legitimately terse. It became a hole only when a class arrived that is short
*because it is not text*.

**Short text is only trustworthy if it is text.** A scope exemption needs its own
precondition, or it is an unexamined edge waiting for the right input.

## A measurement discipline that held twice

Link density looked like a signal for separating index pages from articles
(0.60 vs 0.43 on two samples). It was **declined at n=2** for insufficient
margin, then **killed outright at n=17**: the values run continuous from 0.41 to
0.71 with no gap, and the high end is genuine releases (Tankan, Monetary Base)
scoring high precisely because they link to their data rather than inlining it.
A 0.55 cut rejects the IMES listing at 0.63 — and rejects Tankan and Monetary
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
