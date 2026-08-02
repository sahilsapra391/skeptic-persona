# The commentary floor: a fix withdrawn, and what the measurements found

**Date:** 2026-08-02
**Chunk:** p4-18 — **code withdrawn.** This document is the residue, which is
the part worth keeping.

## What was built, and why it is gone

The claim: a flat 200-weighted minimum on the commentary variant is the
forcing function behind unsourced world-knowledge, because live fact blocks
run 36–277 and a flat 200 demands characters the record cannot fund. The fix
made the floor record-relative — the fact block plus 75, the owner's shortest
signed take.

**The 75 came from the wrong population, and review caught it.**

`lengthCheck` applies the floor only when `variant === "commentary"`. Measured
from `OWNER_EXEMPLARS`, split by register:

| register | n | take min | take median | take max | totals under 200 |
| --- | ---: | ---: | ---: | ---: | ---: |
| wire | 20 | 75 | 111 | 144 | **11** |
| commentary | 7 | **192** | 251 | 271 | **0** |

Three consequences, each fatal to a stated justification:

1. **`MIN_TAKE_WEIGHTED = 75` is a wire exemplar's beat line.** The owner's
   shortest signed *commentary* take is **192**. The docstring's defence —
   "anything higher rejects text he has written" — was false for the register
   the constant governs.
2. **`TARGET_TAKE_WEIGHTED = 124` sat below the shortest real commentary
   take.** The target given to the model was under the floor of the actual
   distribution.
3. **"11 of 27 exemplars under 200; the flat floor rejected 41% of the voice"
   was wrong.** All eleven are wire. **Zero commentary exemplars fall under
   200** — they run 296 to 354. The flat commentary floor rejected none of his
   commentary voice, because it never applied to wire at all.

And under the codebase's own segment splitter — `structuralCheck`'s `/\n\n+/`
and `render.ts`'s `BEAT_SEPARATOR` — **all twenty wire exemplars have no take
segment at all.** The 75–144 figures existed only because the calibration
re-split them on `/\n+/`. The parity tests pinned the constants to the same
wrong population, so they could not catch it.

This is the tautology problem one level deeper. Anchoring on the observed
minimum guaranteed "0 of 27 fail"; anchoring on the **wrong 27** guaranteed a
floor that means nothing for the variant it governs.

## The premise did not survive either

With the register error found, the forcing-function claim was re-tested against
real generations rather than against fact-block arithmetic:

| variant | status | chars |
| --- | --- | ---: |
| commentary | valid | 214 |
| commentary | rejected:template_echo | 233 |
| commentary | rejected:length | ~290 (too LONG) |
| commentary | rejected:entity | — |

**Not one commentary generation has ever been rejected for being too short.**
Two comfortably exceed 200; one was rejected for exceeding the *ceiling*. The
model is not straining upward to reach a floor, which is what the
forcing-function hypothesis predicts.

The arithmetic that motivated the fix assumed the gap between a 115-character
fact block and a 200-character floor must be filled with **facts**. It need not
be: a take is opinion, and 85 characters of opinion require no record at all.

## The finding worth keeping

**Zero of the seven commentary exemplars fit the platform limit.**

```
296, 318, 320, 320, 347, 350, 354      (limit: 280)
```

The model has never been shown a commentary that fits in a post. His commentary
voice is fact block 64–117 plus take 192–271, and that sum does not fit
alongside most of our fact blocks.

That is a product question, not a validator question, and it belongs to the
owner:

- a postable commentary in his voice needs the take compressed to roughly
  160–215, and there is no example of him doing that;
- if a real take is ~192, commentary only fits when the fact block is under
  about 88 weighted — which is roughly halts and nothing else;
- calibrating any floor from **seven over-budget samples** is anchoring on a
  statistic too small and too unrepresentative to carry a rule.

**The honest ask: more commentary exemplars that fit 280.** Until those exist,
no floor derived from the exemplar bank can be defended, and the flat 200
stands — not because it is right, but because nothing measured here shows it
wrong for the variant it governs.

## Two real bugs the withdrawn code contained

Recorded because they will recur if the idea is rebuilt:

- **`factBlockOf` measured line 1, not the fact block.** `render.ts` joins
  fact-block lines with `\n` and attaches the beat with `\n\n`, so a
  multi-line skeleton splits wrong. Measured on live drafts: a Baker Hughes
  8-K whose fact block is 115 weighted reported 20, giving a floor of 95
  instead of 190; a four-line 4.02 draft reported 44 against a real 232, so
  `no_room` never fired where it should have. Multi-line skeletons exist in
  `8k.items` (62 live rows), `INSIDER_CLUSTER` and `CONGRESS_PTR`.
- **The prompt could state an impossible contract.** With no clamp, a
  400-character fact block yields a floor of 475 and the model is told
  `"The CONTRACT is 475-280 weighted chars TOTAL"`.

## A constraint that outlives the withdrawal

Found by the delta review, and it applies to **any** future attempt to record
a pre-generation decision as a status row:

`deliverCards` derives `terminal_status` from `MAX(g.id)` among matching rows.
A `skipped_*` row inserted BEFORE the LLM loop therefore has the **lowest** id
of that item's rows, so any completed outcome outranks it — dry and sharp
valid means terminal `valid`, and the early row is never the one the card
reads. The only path on which such a row becomes visible is one where every
OpenRouter attempt also failed, which is precisely the case where it explains
nothing.

Two consequences that would recur:

- **A pre-flight status is invisible in the common case.** Any "we decided not
  to ask for X" marker inserted early needs a different mechanism than a
  `generations` row, or it must be inserted after the loop.
- **A confident cause can be wrong at the same time.** During an OpenRouter
  outage the rows are `[too_thin, api_error, api_error]`; only the first
  matches the terminal predicate, so the card would have asserted "this record
  cannot fund a take" when the real reason nothing generated was that the LLM
  was unreachable — and dry and sharp carry no minimum and *were* requested.
  The row is permanently terminal, so a healthy tick later does not correct it.

The withdrawn code replaced a vague-but-true label ("generation fell back")
with a confident falsehood, on the only path where the label was visible. That
is worth more than the specific labels: **a status that names a cause must be
derivable at the moment the card is built, not at the moment the decision was
taken.**

## What was right

The `no_room` / `unmeasurable` split — a product outcome and a defect signal
must not share a status, and the defect signal must alert rather than log.
That reasoning survives the withdrawal and should be reused if this is rebuilt.

## Method note

The register error was found by a reviewer who recomputed the distribution,
reproduced every number, and **then asked which population it came from**. The
arithmetic was confirmed and the premise was not — the same shape as every
defect in `2026-08-01-silent-success-retrospective.md`: the check ran, reported
success, and answered a different question than the one that mattered.
