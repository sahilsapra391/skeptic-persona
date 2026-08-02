# The Senate lane is not blocked, and has not been for at least six days

**Observed 2026-08-02T17:0xZ in production D1.** This reverses a
doctrine-level record three sessions have been building on since 2026-07-27.

## The evidence

```
items.id            732539
items.fetched_at    2026-08-02T13:30:01.000Z
items.source        senate_ptr
payload             {"kind":"ptr","display":"McCormick, David H. (Senator)",
                     "firstName":"David H","lastName":"McCormick",
                     "filedDate":"07/29/2026","transactions":[{…
```

```
jobs.senate_ptr        enabled=1  daily_1330_utc  last_ok_at 2026-08-02T13:30:01  fails 0
source_state.senate_ptr  last_polled_at 2026-08-02T13:30:01  fails 0  last_error (none)
```

The Cloudflare Worker completed eFD's three-step handshake, ran the search,
fetched a detail page and parsed transactions out of it — today, on its own
scheduled `daily_1330_utc` slot, with zero failures and no recorded error.

It is not the relay: the Actions senate lane runs only on an explicit
`workflow_dispatch` with `lane=senate`, its schedule is weekdays, and today is
Sunday. `source_state` is written by `pollSenatePtr` itself.

## What this contradicts

**2026-07-27, recorded as an IP/ASN-class fact:**

> efdsearch.senate.gov **403s Cloudflare Workers egress** — tested from prod
> with declared UA, with full browser headers, and with a browser UA: all 403,
> so it's an IP/ASN-class block, not headers.

**2026-08-01, p4-00:** the lane parked with evidence, and an "honest unlock"
recommended in the form of an owner-run residential courier POSTing to
`/ingest`.

Neither survives. The Worker reaches eFD. The courier is not needed, and
[the 2026-08-02 re-test](2026-08-02-senate-efd-retest.md) had already shown it
would not have worked anyway — the same handshake failed identically from a
residential connection, and the 503 body was the Senate's own maintenance
page.

Three findings stacked on one another, each reasonable when made:

1. a real 403 on 07-27, generalised to a permanent property of the IP class
2. a real 503 on 08-01, read as that same block persisting
3. a recommendation built on both, for a path that fails the same way

The first was almost certainly true when measured. **What was wrong was the
tense** — an outage recorded as a property. Nothing re-tested it for six days
because everyone had a citation.

## The lane still produces nothing, for an entirely different reason

Four `senate_ptr` items exist. **All four are `score = 2` (postable) and all
four are `logged`.**

The one that arrived today was filed **07/29** and fetched **08/02** — four
days later. `isFreshDateOnly` allows 48 hours for a date-only source, so it
was stale on arrival and went to the lake, correctly.

So the Senate half of CONGRESS_PTR — the 1.67x flagship archetype — has never
produced a card. Everyone believed the cause was egress. **The actual cause is
that filings reach us days after their filing date and the freshness gate
lakes them**, which is a latency problem with a completely different fix.

What I cannot determine from stored state: whether the polls between 07-29 and
08-02 failed, or whether eFD indexed that filing late. `consecutive_failures`
reflects only the most recent poll and `last_ok_at` is overwritten, so the
history is not recoverable from D1. A daily poll against same-day indexing
would land inside the 48h window comfortably; a four-day lag means one of
those two assumptions is wrong and I have not established which.

## What should happen next, and none of it is what was planned

- **Stop treating the Senate lane as blocked.** It is enabled, polling, and
  parsing. No architecture is required.
- **Drop the residential-courier unlock** from the plan. It solves a problem
  that does not exist, in a way that would not have worked.
- **Measure the lag** before changing cadence: poll frequency is worth raising
  only if eFD indexes promptly and our polls were missing filings. If eFD
  itself publishes days late, no cadence fixes it and the freshness allowance
  for this source is the thing to revisit.

## The transferable part

An outage was recorded as a property, and the record was good enough that
nobody re-ran the one-line check for six days. The 403 was real. "403s
Cloudflare Workers egress" was a measurement; "**it's an IP/ASN-class block**"
was an inference, and only the inference was load-bearing for the six days of
work that followed.
