# Senate eFD, measured from three egress classes in one 15-minute window

**Verified 2026-08-06.** This is the measurement D-25 demands before any
courier work: *a probe from one egress proves nothing about another*, so all
three were probed with the same declared User-Agent inside one window.

## The result

| Endpoint | Cloudflare Worker | GitHub-hosted runner | Residential |
|---|---|---|---|
| `GET /search/home/` | **403** (13:30:44Z) | **200** (13:45:07Z) | **200** (13:45:44Z, repeated) |
| `POST /search/report/data/` | never reached | **503** (13:45:07Z) | **503** (13:45:44Z, then 4/4 at 20s intervals) |

Runner probe: [run 31107396854](https://github.com/sahilsapra391/skeptic-persona/actions/runs/31107396854),
`home=200 agree=411 -> /search/ search=503`. The 411 is a known curl artifact
of following the agreement's 302 as a POST with no body; run without `-L` from
residential the same step returns **302**, which is the correct answer.

## Two DIFFERENT failures, and conflating them is the trap

**1. The Worker is blocked at the home page.** 403 on the very first request,
while a runner and a residential client both get 200 within fifteen minutes.
That is an egress-class block and it is why `senate_ptr` cannot work from the
Worker at all — it never reaches the agreement step, let alone the search.
Recorded as D-45.

**2. The data endpoint is in the Senate's own maintenance.** The 503 body is:

> `U.S. Senate: Site Under Maintenance` … `WEBSITE TEMPORARILY UNAVAILABLE DUE
> TO MAINTENANCE. Normal service will return soon.`

Scanned for vendor markers — `Ray ID`, `cloudflare`, `Akamai`, `Incapsula`,
`captcha`, `Attention Required`: **none present**. This is not bot mitigation.
It hits the runner and a residential client **identically**, so it is not an IP
class either.

**And it is intermittent, which is the whole point.** At 05:15Z the same
residential client, same UA, got the data endpoint answering **200 with 12 real
PTR rows, 27 times out of 27**. At 13:45Z it is 503, four for four. Up in the
morning, down in the afternoon, same day.

## What this settles

- **Runners reach eFD.** The owner's condition for building the courier is met.
- The 2026-08-02 reading was right and is confirmed rather than overturned: that
  doc parked the lane on **UNVERIFIED, not IP-blocked**, and said the test was a
  weekday retry. This is that retry, and it holds.
- The `senate_ptr` Worker job cannot be fixed by any change to the poller. The
  agreement-decoupling in [#155](https://github.com/sahilsapra391/skeptic-persona/pull/155)
  was correct on its own terms and is downstream of a request that 403s.

## What it does NOT settle

Whether the maintenance window is scheduled, and therefore whether a courier
cadence can be aimed at it. Two observations (up at 05:15Z, down at 13:45Z) is
a direction, not a distribution — the same discipline that made the registry's
"503s two polls in three" an invented number is what stops this becoming one.
The courier's own run history is the instrument that answers it.

## The correction this forced on my own report

I told the owner the Worker 403 was "same family as cftc.gov 403, treasury.gov
525, rate_boe 500." The **home-page 403 is** that family. The data-endpoint 503
is not — it is a maintenance page every client sees. Reporting the two under
one heading would have sent a courier build at a problem the courier cannot
solve, and would have made the eventual 503s look like the courier failing.
