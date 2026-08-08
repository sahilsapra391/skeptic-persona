# p5-25 Bluesky — the corroboration evidence (B-16.3)

Measured 2026-08-08 on the lane's first full production harvest, 121 items.
B-16.3 asks for per-term volume and how many items would clear a corroboration
bar **before** any promotion above log-only. The answer is none, and the reason
is structural rather than a matter of tuning.

## Per-term volume

| Term | Items | Distinct handles | With a cashtag |
|---|---|---|---|
| `Schedule 13D` | 25 | 8 | 12 |
| `SEC enforcement action` | 25 | 20 | 1 |
| `Form 4 filed` | 25 | 2 | 24 |
| `8-K filed` | 25 | 2 | 3 |
| `WASDE report` | 21 | 17 | 1 |

## The handle concentration is the finding

| Handle | Items | Distinct terms |
|---|---|---|
| `formdelta.bsky.social` | 24 | 1 |
| `item502.eyesec.it` | 22 | 1 |
| `gunpowderusa.bsky.social` | 17 | 1 |
| `securitieslaw.bsky.social` | 5 | 2 |
| `quant-hub.bsky.social` | 4 | 2 |

The three biggest contributors each post on **exactly one** term. `item502`
names an 8-K item code in its own handle. These are single-purpose EDGAR
republisher bots, and between them they are most of the lane's SEC volume.

## Why nothing clears the bar

**Corroboration requires an independent source.** A bot republishing EDGAR is
not independent of EDGAR; it is downstream of it, and slower. We already ingest
the same filings directly:

```
edgar_form4      13,803 items
edgar_8k          4,125 items
sec_schedule13    1,463 items
```

Confirming an EDGAR filing with a Bluesky post *about that EDGAR filing* is
circular. It adds a second mention, not a second source.

The two genuinely diverse terms fail for the opposite reason.
`SEC enforcement action` (20 handles) and `WASDE report` (17 handles) carry a
cashtag in **1 of 25** and **1 of 21** items respectively, so there is nothing
to match an issuer on. They are commentary, not pointers.

So the split is exhaustive and unhappy: where the lane has volume it is
echoing a lane we already run, and where it has independence it has no handle
to corroborate against.

**Items that would clear a corroboration bar today: 0 of 121.**

## What this does not say

It does not say the lane is worthless. It says the lane has not earned a tier
above log-only, which is precisely the question B-16.3 asked. A discovery lane
that notices nothing we did not already know is still cheap, still incapable of
carding by construction, and still worth a week of data before a verdict.

## Reopen conditions for a promotion

A promotion above log-only needs at least one of:

1. **A pointer we did not already hold.** A Bluesky item naming a filing
   accession or issuer that our EDGAR lanes had not ingested first. Measurable
   directly: join `bluesky_discovery` payload text against `items.external_id`
   and count misses.
2. **Independent handles carrying identifiers.** A term where distinct handles
   exceed, say, ten AND cashtag density is high enough to resolve an issuer.
   Today no term satisfies both; `Form 4 filed` has the identifiers and 2
   handles, `SEC enforcement action` has 20 handles and 1 identifier.
3. **A non-EDGAR domain where we have no direct lane.** The lane's one
   plausible future is a subject this desk does not already read at source.

Until one of those holds, `SCORE_LOG_ONLY` is not a placeholder — it is the
correct tier, and the lane's construction (no archetype, no attribution entry,
no enqueue path) already makes it unable to be anything else.

## A narrowing worth considering, not taken here

`WASDE report` returns hashtag farm-timeline noise (emoji, `#Bread #Food`) at
1 cashtag in 21. It is the weakest term by both measures. Left in place for a
week of data rather than cut on one harvest, but it is the first candidate if
the lane is trimmed.
