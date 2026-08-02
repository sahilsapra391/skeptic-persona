# Derived lag fields — measured against the exemplars, 2026-08-01

Two sessions flagged the same gap: the owner's CONGRESS_PTR exemplars reach
for figures the payload does not carry, the fabrication gate refuses the
arithmetic that would produce them, and the prompt has been claiming since
p4-01 that *"derived figures are already computed as fields"* when they were
not.

Both reported four failing exemplars (E1, E2, E5, E6). **Running them through
`numberCheck` against a real House payload gives a different answer, and the
difference changes what needed building.**

| Exemplar | Reported | Measured | Cause |
|---|---|---|---|
| E1 "six weeks stale" | fails | **passes, by coincidence** | see below |
| E2 "Sixty-one days" | fails | **passes** | `lagDays` already covers it |
| E3 "Nine days" | — | passes | `lagDays` |
| E4 "Up to 118 days" | — | **fails** | no field states the oldest lag |
| E5 "Eighty-seven days late…" | fails | **fails, on other tokens** | see below |
| E6 "Thirty-nine days late" | fails | **passes** | `lagDays` |

`wordNumberCheck` composes hyphenated compounds, so "Sixty-one" resolves to
61 and matches `lagDays: 61`. Three of the four reported failures were never
enrichment gaps.

## E1 was worse than a rejection

`payloadFacts` harvests every numeric token in the payload JSON, and that
includes **month numbers**. A trade dated `06/03/2026` puts a `6` in the
licensed set. So "six weeks stale" passed — not because the payload said six
weeks, but because the trade happened in June.

Measured on one filing, changing nothing but the month:

```
trade 06/03, filed 07/18 (lag 45)  ->  []                        PASS
trade 08/03, filed 09/17 (lag 45)  ->  spelled-out "six" (6)     FAIL
                                       does not appear in the payload
```

Same lag, same true sentence, opposite verdicts. **A validator whose answer to
an identical claim depends on the trade month is worse than one that always
refuses**, because the failure looks intermittent and nobody chases it.

`lagWeeks` makes it pass for the stated reason on every month.

## E4 is the clean gap

`lagDays` is the NEWEST trade's lag — the honest answer to "how late was this
filing". "Up to 118 days of lag, all cleared in one afternoon" is about the
OLDEST trade, and no field stated it. That is `maxLagDays`.

The distinction is real, not cosmetic: a PDF clearing eleven trades from March
to May is 4 days late on its newest trade and 118 on its oldest, and only the
second number describes what the filing is.

## E5 is not an enrichment gap and must not become one

It fails on `45.` and `$200.` — the STOCK Act filing deadline and its penalty.
Those are **world knowledge, not parsed fields**. No amount of enrichment
should license them, and a test now pins that they stay refused so a later
widening has to argue with it.

This is the world-knowledge gap already on the roadmap, showing up in the
owner's own voice. Worth noting the tokens carry their trailing period (`45.`,
not `45`), which is a separate tokenizer question in the RAG session's lane.

## What shipped

`lagWeeks(days)` and `maxLagDays(filedIso, txns)` in `src/ingesters/shared.ts`,
wired into **both** PTR payloads — one disclosure under one statute, and a
reader should not be able to tell which parser produced the line.

Both are computed **at ingest from parsed dates**. The model still never does
arithmetic; the doctrine is untouched. This is the same precedent as `lagDays`
and `bandSpanRatio`.

`form4.ts` also carries a `lagDays` and was deliberately left alone: no
exemplar reaches for a Form 4 lag in weeks, and adding a field nothing
consumes is how payloads get wide without getting useful.

## Not fixed here, and visible in the measurement

`payloadFacts` licenses more than the payload states. The numeric set for one
ordinary House filing:

```
0.000002026, 0.001000001, 0.002026, 0.003999999, 0.005, 1, 1.000001,
1000.001, 1000001, 18, 2.026, 2026, 3, 3.999999, 3999.999, 3999999,
45, 5, 5000, 5000000, 6, 7
```

`6` and `7` are month numbers. `2.026` and `0.002026` are a year read as a
decimal. `3999.999` and `0.003999999` are the band width scaled. Each of these
is a number a draft may state and be believed about. Out of scope for this
chunk — the fix is in the validator, not the ingesters — but recorded, because
E1's accidental pass came from exactly this and the next one will too.
