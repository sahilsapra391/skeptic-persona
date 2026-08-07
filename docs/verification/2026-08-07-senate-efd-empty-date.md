# Senate eFD: the 503 was an empty date field (D-71)

Measured 2026-08-07, 15:44–16:10 UTC. **Supersedes D-46, D-70, and the
2026-08-02 retest note.** Every one of those reasoned about the network. The
variable was never the network.

## The finding

`POST /search/report/data/` returns **503 carrying eFD's own maintenance page**
when `submitted_start_date` is sent empty. With any bounded start date it
returns **200 with real rows**.

Measured back to back on ONE residential session, same cookie jar, same
declared UA, alternating, four trials each:

```
submitted_start_date=                      -> 503  maintenance page   4/4
submitted_start_date=01/01/2026 00:00:00   -> 200  108 records        4/4
```

Deterministic. Not intermittent, not rate-limiting, not an IP class.

It is also **not about result-set size**, which was the obvious next guess:

```
start=01/01/2012  -> 200   recordsTotal 2406
start=01/01/2020  -> 200   recordsTotal  962
start=01/01/2025  -> 200   recordsTotal  275
start=01/01/2026  -> 200   recordsTotal  108
```

Twelve years of history returns fine. Only the *unbounded* form is refused.

## Why three previous investigations missed it

Every earlier reading tested the **wrong request** and then reasoned about the
network around it.

| Earlier claim | Status |
|---|---|
| "residential 503s too, so it is not the Azure IP class" | The observation was right. The inference was wrong: residential was sending the same broken query. |
| "Worker 403s at the home page, so senate cannot work from the Worker" | The Worker now reaches `/search/home/` at **200 in 78 ms**. |
| "intermittent — the same residential client got 200 with 12 rows" | That run used a bounded date. The variable was never time. |
| D-70: "an IP-class block wearing maintenance clothes" | **Mine, and wrong.** Written the same afternoon, on a real measurement of the wrong request. |

The soft-skip's body test was never the weak part. It correctly matched a page
that really did say `TEMPORARILY UNAVAILABLE`. **The page was a lie told in
response to our own malformed query**, and no amount of checking the page could
have revealed that.

The generalisable rule, and it is the third time this repo has paid for it:
**before concluding anything about the network, verify you are sending the
request you think you are sending.**

## The fix

`.github/workflows/ingest-relay.yml`, the courier's search POST:

```
--data-urlencode "submitted_start_date=${SINCE} 00:00:00"
```

with `SINCE=$(date -u -d '30 days ago' '+%m/%d/%Y')`. Thirty days rather than
the Worker poller's seven, because this lane runs three times on weekdays and a
wider window costs nothing (`dedup_key` absorbs the overlap) while recovering a
backlog whenever the lane has been down — which is the exact situation it is
shipping into. At the current rate (~15 filings/month) that is well inside one
`length=25` page.

**`src/ingesters/senatePtr.ts` needed no change.** The Worker-side poller has
always sent a bounded 7-day date. It was never the broken half.

## Live dispatch run (D-48)

Run [31195679601](https://github.com/sahilsapra391/skeptic-persona/actions/runs/31195679601),
branch `d71-senate-empty-date`, lane `senate`:

```
senate -> success, 6 steps
relay response: {"ok":true,"inserted":18,"queued":0}
```

**18 real Senate PTR filings ingested**, the first Senate data since
2026-08-02.

### Why `queued` is 0, and why that is correct

`ingestEfdRow` sets `status: parsedOk && fresh ? "new" : "logged"`, where
`fresh` is `isFreshDateOnly` — a **48-hour** window
(`2 * STALE_AT_INGEST_HOURS`). The newest PTR on eFD is filed **2026-08-05**,
which is **64 hours** old.

So every filing in the recovered backlog is correctly `logged` rather than
carded. A lane that has been down five days should not wake up and post
five-day-old filings as news. **There is nothing fresh to card right now**;
cards appear on the next PTR filed while the lane is healthy.

Items landed: 18 (17 at `SCORE_POSTABLE`, 1 at `SCORE_LOG_ONLY`), total
`senate_ptr` rows now 22.

## Second defect, found by the same run

**The relay handler never wrote `source_state`, for any source.** It inserted
rows and drained, and left the health row holding whatever the last *direct*
poll had put there.

Observed during the successful run above:

```
senate_ptr: consecutive_failures=5  last_error="efd home 403"  last_ok=2026-08-02
```

while 18 filings were landing through that exact code path. **That stale row is
what the previous diagnosis was built on.** A health table that reports a
five-day-old error during a successful ingest is worse than no table.

Fixed in `src/ingestRelay.ts`: a successful relay clears failures and stamps
`last_ok_at`/`last_polled_at`; a 422 increments `consecutive_failures` and
records the error. The increment sits at the call site because
`recordSourceError` only writes `last_error`/`last_error_at` and every existing
caller bumps the counter itself; matching that convention beats changing a
helper five ingesters depend on.

## The skip is now bounded by duration

Quiet once, loud if it persists. A first-skip timestamp rides the Actions
cache; past a 24-hour grace window the skip becomes a hard failure with a
message naming this defect first:

> senate eFD has returned its maintenance page continuously for Nh. That is no
> longer a maintenance window. Check the QUERY before the network: an empty
> submitted_start_date reproduces this page exactly (D-71).

The state machine was exercised against four scenarios before shipping
(maintenance-then-recovery, recovery not inheriting a dead streak, persistent
outage going loud at 24h and staying loud, and corrupt state not wedging the
lane). Truncate-not-delete on reset is deliberate: a missing file would leave
the previous cache as the newest `restore-keys` match and resurrect a dead
streak.
