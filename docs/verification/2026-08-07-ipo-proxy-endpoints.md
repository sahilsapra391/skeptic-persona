# p5-30 / p5-31 — endpoint and cross-reference verification

Probed 2026-08-07 with the declared UA. All seven form feeds answered 200
`application/atom+xml`.

```
S-1        31 entries      DEFC14A    1 entry
S-1/A      11 entries      PREC14A    1 entry
424B4      10 entries      DFAN14A    6 entries
                           DEF 14A   26 entries
```

## The volume split IS the design

`DEF 14A` is the routine annual meeting: 26 entries against DEFC14A's 1. The
`C` in DEFC14A/PREC14A is literally "contested", so those two are rare and
self-identifying, which is the ideal shape for this desk. **DEF 14A is
excluded deliberately**, not overlooked.

## The pairing that would have broken the lane silently

Every DFAN14A filing comes back **twice**, once under each party:

```
0001140361-26-031676   Filed by  0001743937  TOMS Capital Investment Management LP
                       Subject   0001535929  Voya Financial, Inc.
0000921895-26-001971   Filed by  0001472520  DGB Investment, Inc.
                       Subject   0000896156  ETHAN ALLEN INTERIORS INC
```

Six feed rows, three real filings. `edgar8k`'s title parser hard-codes
`\(Filer\)` and would have dropped all six. A naive dedup keeps whichever row
arrives first, which is non-deterministic — and if the `Subject` row won, the
13D cross-reference would look up the **target company's** CIK instead of the
activist's and silently find nothing.

So the parser merges the pair. Both sides are kept: the filer becomes
`company`/`cik`, the target becomes `subjectCompany`/`subjectCik`. Naming the
target is what turns "TOMS Capital filed X" into a sentence.

## The cross-reference fired on the first real data

We hold **1,448** `sec_schedule13` rows. Matched on CIK, never on name.

```
CIK 0001743937 (TOMS Capital)   -> 0 prior 13D filings in our lake
CIK 0001472520 (DGB Investment) -> 1 prior 13D filing
```

DGB Investment, Inc. filed a **Schedule 13D on 2026-08-04** reporting **4.1% of
ETHAN ALLEN INTERIORS INC**, then filed **DFAN14A soliciting material regarding
ETHAN ALLEN INTERIORS INC on 2026-08-06**. Stake disclosed Tuesday,
solicitation Thursday, both parsed from our own lake with no claim joining
them.

TOMS Capital returning zero is the honest case: our 13D lane started recently
and does not reach back far enough. The lane says nothing about a stake it
cannot see, rather than implying one.

## Percent selection, on group filings

A 13D can name several reporting persons at different percentages. The lane
reports **this filer's own** `percentOfClass`, never the filing's `topPercent`,
because on a group filing those are different people and attributing the
group's largest stake to this filer would be a fabrication with a citation
attached.

## Both lanes ingest at LOG-ONLY

Neither has an archetype or an exemplar bank. The gate refuses generation when
a bank is empty, so scoring these postable now would produce a template card
with no voice — the exact defect B-07/B-08 removed, where four cards sat at
`skipped_no_exemplar` for weeks. The archetypes and their exemplars are the
follow-on chunk; the lake fills meanwhile, which the amendment counter needs
anyway.
