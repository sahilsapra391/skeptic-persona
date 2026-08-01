# The voice authority and the fabrication floor have never been checked against each other

**Date:** 2026-08-01
**Severity:** live, in production, today. Independent of the chunk that found it.
**Found:** while verifying a design workflow's claims about `entityCheck`
rather than relaying them.

## The finding, in one line

**The owner's own exemplars teach the model a construction that `entityCheck`
rejects**, so the pipeline is generating drafts it is then obliged to throw
away.

## Reproduction

Exemplar E1 (`CONGRESS_PTR`, `src/rag/stylepack.ts`) line 2 is `Filed July 18.`
Run a draft written in that taught style against `entityCheck`, with the
matching PTR payload — the payload that *contains* `disclosedDate:
"2026-07-18"`:

```
REJECT  "Senate PTR: $1,000,001 - $5,000,000 purchase in a defense prime, trade date
         June 3, per Senate eFD.\nFiled July 18.\nLegal, disclosed, and six weeks stale."
        -> name "Filed July" does not appear in the payload

REJECT  "Filed July 18."       -> name "Filed July"
REJECT  "Disclosed July 18."   -> name "Disclosed July"
REJECT  "Reported June 3."     -> name "Reported June"
REJECT  "Sold March 12."       -> name "Sold March"
pass    "filed July 18."       (lowercase control)
```

## Cause

`entityCheck`'s name pattern requires two capitalised tokens:

```
/\b([A-Z][a-z]+(?:[-\s][A-Z][a-z]+)+)\b/
```

A sentence-initial capitalised verb followed by a month satisfies it.
`Filed July` is read as a proper name, and proper names must appear in the
payload. The date *is* in the payload; the phantom person is not.

Same shape hits `One House`, `Four Form`, `All Code` — numeral-word plus
capitalised noun — which also appear in owner exemplars.

## Why nobody caught it

`test/stylepack.test.ts` runs the exemplars through `checkRegister` and
`fitsInPost`. It does **not** run them through `entityCheck` or `numberCheck` —
the fabrication floor that actually judges their imitations. Nothing anywhere in
`test/` does.

Its own comment states the correct principle and then applies it to one gate
of two:

> The pack's examples are the model's imitation targets. An example that fails
> the register would teach the model to fail it too.

Exactly right, and the same sentence is true with "the floor" substituted for
"the register". **The voice authority and the fabrication floor are two
independently-maintained specifications of the same output, and no test has
ever compared them.**

## Consequence

A self-inflicted rejection loop. The exemplar teaches `Filed July 18.`; the
model obliges; `entityCheck` rejects it as a fabricated entity; the row
regenerates with feedback; the feedback cannot resolve the conflict because
the prompt is still holding up the exemplar as the voice to match. Attempts
burn toward `MAX_ATTEMPTS` and the row lands on the template fallback.

That failure is invisible in the metrics as they stand — and until the fix in
p4-09a, a template fallback that shipped was booked as a **zero-edit win**, so
this defect would have *raised* the headline number.

## The fix, and why it is its own PR

Two changes, neither of which belongs inside a feature chunk:

1. **Tighten the name pattern** so a sentence-initial capitalised verb followed
   by a month is not a name. Needs its own false-positive corpus; a bare
   sentence-initial exemption is too broad, because a fabricated name genuinely
   can open a sentence.
2. **Add the missing cross-check**: every owner exemplar must pass the same
   floor its imitations face, against its own archetype's payload shape. This
   is the test that would have caught it, and it is worth more than the regex
   fix, because it makes the two specifications answer to each other from now
   on.

## A second, unrelated hole in the same function

`entityCheck` only matches **multi-token** proper nouns, so single-token
venue and institution names are unchecked entirely. Against the live 5-field
CFTC payload:

```
"The contract traded on Polymarket until the order landed."  -> []
"Kalshi listed the contract and kept listing it."            -> []
"Nasdaq had nothing to do with it."                          -> []
```

Naming a real venue is what makes a fabricated causal claim concrete, so this
is the more dangerous direction of the same regex. Fixing it needs a common-caps
allowlist and the FURNITURE set, which is why it is scoped with the above rather
than bolted onto a validator chunk.

## Note on provenance

Both `entityCheck` claims originated in a design-workflow agent's report. I
reproduced each one against the real exported function before recording it
here, and corrected one of my own reproductions along the way: an initial run
reported 9 of 27 exemplars flagged, but most of those were placeholder tickers
(`$XYZ`) tested against a mismatched payload — my harness error, not a product
defect. The numbers above are the ones that survive testing an exemplar
against its own archetype's payload.
