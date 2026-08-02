# Fleet health sweep, first one with production D1 access

**2026-08-02T05:3xZ.** Thirty-nine enabled jobs, checked directly rather than
through the health report — which turned out to be the point, because the
report could not see one of the two things that were wrong.

## Correction to #116 first

That PR's body and commit message say `source_health` *"self-healed once the
column existed"*. **Past tense, and not verified when I wrote it.**

What is verified: migration 0048 applied at 05:09Z, and the exact query that
was throwing now executes against live D1 and returns two rows. What had NOT
happened at the time of writing: the job re-running. Its `due_at` is
06:04:10Z, `consecutive_failures` is still 8, and `jobs.last_ok_at` is still
the pre-breakage 22:23:01Z.

So the accurate claim is **the cause is removed and the next run should
succeed**, resolving at 06:04Z on its own. I asserted the outcome because the
mechanism was obvious, which is the specific move this project keeps recording
against other people.

## Two sources failing, both explained, neither a defect

```
rate_boe                8 fails   last source OK 2026-08-01T14:51Z   500
press_cftc_enforcement  6 fails   never succeeded                    403
```

**CFTC** is documented and deliberate: the host 403s Cloudflare Worker egress,
the lane is parked as an auto-recovering probe, and doctrine #4 forbids
disguising the client to get past it.

**BoE** matches the pattern already written into `rates.ts`: IADB 500s
overnight and recovers in UK business hours. Eight hourly failures land at
roughly 22:33–05:33Z, i.e. **23:33–06:33 UK**, which is overnight. Tested the
same URL from a residential connection at 05:36Z (06:36 UK): **HTTP 200, 4,268
bytes of valid CSV**, three minutes after the Worker's 500.

Three minutes apart is not enough to separate "just recovered" from "answers
residential and not Worker egress", and I am not going to claim which. The
next poll at 06:32Z distinguishes them at no cost. The existing comment says
transient, and nothing here contradicts it.

## The health report was blind to the worse of the two

`source_health` itself had `jobs.consecutive_failures = 7` for seven hours and
appeared in no report. Fixed in #116; the sweep is how it was found.

Worth separating what the two counters mean, because this sweep only makes
sense once they are apart:

| | means |
|---|---|
| `source_state.consecutive_failures` | the SOURCE did not answer |
| `jobs.consecutive_failures` | the HANDLER threw |

`rate_boe` is the clean illustration. Its `jobs.last_ok_at` is **05:33:01Z —
the same poll that recorded the 500.** The handler caught the fetch error,
wrote it to `source_state`, and returned normally, so the job is genuinely
healthy while the source is genuinely not. Reading either counter alone
misreports it, in opposite directions.

## What the sweep did NOT find, which is most of it

Eleven enabled jobs have never written an `items` row. Ten are correct:
watchers, digests, updaters and the poster write no items by design, and
`halt` / `insider_cluster` are item sources whose names differ from their job
names — my first query joined `items.source = jobs.name` and reported all
three as defects until I checked the assumption.

Nothing else is failing. 26 press sources, 10 rate sources, the FDA lanes and
the EDGAR lanes all report clean.

## Standing hazard this sweep demonstrates

The BoE case is the reason the two counters exist, and the `source_health`
case is what happens when a report reads one of them. Both were invisible to
`/health` before #116, for opposite reasons: one because the failure was in
the column nobody queried, the other because the failure was in the row that
had no source at all.
