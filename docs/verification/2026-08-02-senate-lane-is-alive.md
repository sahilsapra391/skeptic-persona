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

---

## Addendum, 2026-08-02T17:33Z — availability does not track client class

Three samples now, all on the same Sunday:

| time | client | result |
|---|---|---|
| 05:36Z | residential | **503**, Senate maintenance page |
| 13:30Z | **Cloudflare Worker** | **200**, full handshake, PTR parsed |
| 17:33Z | residential | **503**, Senate maintenance page |

**The Worker succeeded between two residential failures.** Whatever gates
`/search/report/data/`, it is not the requesting IP class — that theory is now
dead in both directions, and the surviving explanation is an endpoint that is
intermittently unavailable to everyone.

### This probably answers the arrival-lag question

The open question was whether eFD indexes filings days late, or whether our
polls were failing and leaving no trace. A third availability sample makes the
second look far more likely: `senate_ptr` runs **once a day** on
`daily_1330_utc`, and a single daily attempt against an endpoint that 503s for
long stretches will silently miss whole days.

The misses leave nothing behind. `consecutive_failures` resets on the next
success and `last_ok_at` is overwritten, so a week of one-in-three polls
landing looks identical in D1 to a week of perfect polls.

**Stated as likely, not established.** Three samples is not a distribution,
and I have not observed a poll failing — only that the endpoint was down twice
when I asked. The cheap next step is a retry inside the existing daily slot
rather than a cadence change: two or three spaced attempts cost nothing
against a source that publishes a handful of filings a day, and they convert
"missed the window" into "hit it on the second try" without asking eFD for
more traffic.

Deliberately not built here. The lane is the flagship's other half and it is
now known to work; the next person to touch it should have this recorded
before choosing between a retry, a cadence change, and a freshness allowance,
because those are three different fixes for three different causes and only
one of them is supported.

### One more thing this rules out

The `daily_1330_utc` slot was chosen when the lane was believed dead, as a
cheap auto-recovering probe. **13:30Z is 09:30 ET** — inside US business hours
and, on the evidence above, a slot that does sometimes work. Nothing suggests
the slot itself is wrong, so a fix that only moves the hour is unlikely to
help.
