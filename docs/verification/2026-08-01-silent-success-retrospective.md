# Six defects in one evening, none of which errored

**Written 2026-08-01**, from work across three concurrent sessions (ingestion,
p4/ops, generation). Filed in `verification/` rather than as a design doc
because every claim below is a measurement someone took, and the numbers are
the point.

## The finding

Six independent defects were found on 2026-08-01. **Not one of them threw an
error, failed a test, or turned a check red.** Every one reported success while
meaning something else.

| # | What reported success | What was actually true |
|---|---|---|
| 1 | `corpusEchoCheck` returned "no match" on every draft | `echo_ngrams` held **0 rows**; the check had been a no-op since 07-28 |
| 2 | A patch script printed `polish applied` | Python `str.replace` silently no-ops on a missing anchor; **nothing changed** |
| 3 | The issuer gate suppressed a filing as "not listed" | `issuerCik` had failed to **parse**; absence of a lookup became evidence of absence in the market |
| 4 | An 8-K grounding fetch returned HTTP 200, non-empty | 2,077 chars of EDGAR **navigation chrome and a GTM snippet**, not the filing |
| 5 | A press-release fetch returned 200, 106,641 chars | A **PDF**, tag-stripped into object tables; `/Prev 223302` entered the fact whitelist |
| 6 | A short grounding text passed the prose gate | A **spreadsheet**: ~10 tokens because binary has no spaces, so it fell under a 20-token exemption |

Adjacent instances of the same shape, found the same day:

- `index.json` reports document `type` as an **icon filename** (`"text.gif"` for
  every entry) — a field that looks like type and is not.
- `wrangler d1 migrations apply` prints **"No migrations to apply!"** identically
  for "nothing pending" and "your checkout doesn't contain the file". It bit the
  owner twice and a session once.
- GitHub's **MERGEABLE** flag compares each branch to main *as it is now*, and
  says nothing about branch B after branch A lands.
- A `.bin.fixture` extension fails `?raw` at **module resolution**, not at read.
- Literal control bytes inside committed test fixtures are **invisible in every
  diff**, and made exact-match editing fail against the file.

## Two generalisations

**1. A check that cannot distinguish "not there" from "not loaded yet" is not a
check.** Four of the six are that exact confusion. The fix is never a better
threshold; it is a coverage precondition. The issuer gate's correction is the
model: it draws a negative inference *only* when its reference table holds
≥5,000 rows and was refreshed within 7 days, and otherwise degrades to passing
filings through. Reading a failed refresh as "nothing is listed" would have
silenced an entire source at once — a far worse failure than the one being
fixed.

**2. Four of the six were found by measuring something we already believed, not
by hunting bugs.** Nobody went looking for #1, #4, #5 or #6. Each surfaced when
someone checked a number they expected to be boring:

- "is the echo table populated?" → 0 rows
- "what did that fetch actually return?" → chrome
- "which of these six feeds ship a body?" → three don't, two link to PDFs
- "does my gate catch the class you just found?" → no

## The rule that follows

**Assert the outcome, not the edit.**

Hard-asserting that a patch anchor matched proves the edit landed somewhere. It
says nothing about whether the resulting behaviour is right — and an anchor can
match while the replacement is subtly wrong. What proves something is a probe of
the real system, after the change, phrased as the claim you actually care about.

Concretely, from this evening:

- Loading 726,579 hashes was not verified by "146 commands succeeded". It was
  verified by querying production for a corpus 8-gram (**hit 3 of 3**) and an
  owner-exemplar 8-gram (**hit 0 of 3**).
- The binary-gate fix was not verified by a passing test. It was verified by
  re-running the *original failing probe* against the shipped code: 10 tokens,
  exemption would have said prose, guard now returns false, terse context line
  still true.
- Nine PRs merging cleanly was not verified by nine MERGEABLE flags. It was
  verified by merging all nine into a throwaway worktree and running the
  combined suite: **709 tests, typecheck clean, migrations 0041–0045 sequential**.

## Two notes on the sixth

It is worth separating, because it is the only one where a **guard created the
gap** rather than missing it. The 20-token exemption was *correct in isolation*:
a word-ratio over a handful of tokens is noise, and lake-context lines are
legitimately terse. It became a hole only when a class arrived that is short
*because it is not text*.

The phrasing that fixes it generalises past this case: **short text is only
trustworthy if it is text.** A scope exemption needs its own precondition, or it
is an unexamined edge waiting for the right input.

And a measurement discipline that held twice: link density looked like a signal
for separating index pages from articles (0.60 vs 0.43 on two samples). It was
declined at n=2 for insufficient margin, then **killed outright at n=17** — the
values run continuous from 0.41 to 0.71 with no gap, and the high end is genuine
releases (Tankan, Monetary Base) scoring high precisely because they link to
their data rather than inlining it. A 0.55 cut would reject those and accept the
listing at 0.63. Not a threshold problem: the metric measures the wrong thing.

## For whoever picks this up

Before trusting any green signal, ask what question it actually answers. The six
above all answered a real question correctly — it just wasn't the question being
asked of them.
