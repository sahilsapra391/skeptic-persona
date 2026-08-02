# Discovery mesh, FAST tier — live endpoint verification and capacity math

Owner instruction: maximal source coverage, fastest detection, "post the most
updated financial news before anyone else". The plan's FAST tier (1 min) is
PR wires + Bluesky.

Verified live 2026-08-02. **Two of the four named PR wires do not work, one of
Bluesky's two halves does not work unauthenticated, and the tier as specified
does not fit the tick even after p4-12.** Numbers below.

## Endpoint verification

Declared UA `Skeptic Wire admin@spechawk.ai`, from a residential connection.

| source | status | result |
|---|---|---|
| PR Newswire `/rss/news-releases-list.rss` | **200**, 42,157 b, XML | usable |
| GlobeNewswire `/RssFeed/orgclass/1/...` | **200**, 32,667 b, XML | usable |
| Business Wire `/portal/site/home/news/` | **403** | blocked |
| ACCESSWIRE `/users/rss.aspx` | **302 → /public/message/invalid** | dead URL |
| Bluesky `app.bsky.feed.getAuthorFeed` | **200**, JSON | usable, unauthenticated |
| Bluesky `app.bsky.feed.searchPosts` | **403** | needs auth |
| GDELT `api/v2/doc` (MEDIUM tier) | **200**, JSON | usable |

**The owner's Bluesky spec was two halves and only one is available.** He asked
for "a curated author list AND a keyword search list". `getAuthorFeed` and
`getProfile` answer unauthenticated; `searchPosts` returns 403. So the curated-
author half ships free, and keyword search needs an app password — the
[VERIFY] item he flagged, now resolved: **it does need one.**

**These are residential results and this project has been burned by exactly
that gap.** Senate eFD answers a browser and 403s Cloudflare egress; NSE resets
on a declared UA; treasury.gov TLS-fails from Workers on two hosts. Every row
above must be re-verified FROM THE WORKER before its ingester ships, and
Business Wire's 403 may be either a general block or an egress-class one — it
is a 403 from a residential IP, which is the worse sign of the two.

## Capacity: the FAST tier does not fit, and I will not pretend otherwise

Measured, 2026-07-28 production:

```
ranThisTick:4  deferred:5  elapsedMs:68577
```

**4 jobs, 68.6 s → ~17 s per job.** With p4-12 (concurrency 3) a 45 s budget
buys roughly 2.6 waves, so **~8 jobs per tick, up from 4.** At the ceiling of
6 it is ~16. Against ~40 existing jobs plus a 5-source FAST tier due EVERY
minute, the FAST tier alone would claim most of a tick and starve the filings
lane — the opposite of the goal, since an 8-K is the thing we are actually
trying to be first to.

So the honest statement, in the form the owner asked for: **the 1-minute FAST
tier does not fit, and p4-12 makes it possible rather than sufficient.**

### The cheapest unlock is architectural, not financial

- **Cloudflare free plan allows 5 cron triggers per ACCOUNT; this Worker uses
  1.** Additional triggers produce additional concurrent invocations, each
  with its own subrequest and CPU budget — real parallel capacity, not a
  bigger slice of the same tick. A second cron dedicated to the FAST lane is
  free and is the obvious first lever.
- Splitting the FAST lane into its own Worker is the same idea with more
  isolation and more moving parts.
- Paying changes nothing here: the binding limit is wall time inside one
  invocation, not a plan quota.

### What has to be measured before any of that is chosen

**~17 s per job is one data point from one log line, and it is doing far too
much work in this document.** It is an average over four unnamed jobs, and the
mix matters enormously: `edgar_8k` fans out to ten enqueues, `halts_nasdaq` is
one small fetch. Sizing a mesh on it would repeat the mistake this project has
punished all week — asserting a number rather than measuring it.

**Next chunk before mesh code: per-job duration instrumentation.** Record
elapsed ms per job on the existing `jobs` row, then size the tier against a
real distribution. It is a small change, it answers the question the owner's
own amendment demanded ("how many of the ~45 jobs a tick can actually
complete, not how many subrequests fit"), and every mesh decision after it
rests on data instead of on one line from a log.

## Recommended sequencing

1. **p4-12 concurrent dispatch** (open, PR #91) — prerequisite, ~2× capacity
2. **Per-job duration instrumentation** — turns the capacity question into a
   measurement
3. **MEDIUM tier first, not FAST**: GDELT (15-min cadence, verified 200),
   Google News RSS, the owner-signed outlet list. It is the tier whose
   cadence the current tick can already absorb, and it carries the
   no-filing-event coverage that is the actual gap — filings we already get
   faster than anyone relaying them.
4. **FAST tier** once instrumentation says what fits, with a second cron if
   the numbers require it: PR Newswire + GlobeNewswire (verified), Bluesky
   curated authors (verified), Business Wire and ACCESSWIRE dropped or
   re-sourced.

Every source in every tier still obeys the standing rules: discovery is never
citation, one event is one card via WIRE near-dup, social needs a second
independent feed before it can push, and health quarantine applies.
