# Source registry: every source that is not simply working

**Purpose (p5-11):** *"Nothing rots silently."* Any source that is failing,
parked, quarantined or retired appears here with a **status and a date**. A
source missing from this file and missing from the failure list below is
working; there is no third state.

**Last swept:** 2026-08-06, against live `source_state` and `jobs`.
(Prior sweep 2026-08-05; the 2026-08-06 pass reclassified `rate_bcb` and added `senate_ptr`'s instrumentation note.)

> **Correction, same day.** This file first recorded `rate_boe` as FIXED on the
> strength of a URL change. It is not fixed. The repointed URL deployed and the
> next poll failed identically. See the entry below and D-25 in the ledger: the
> path move was real but was never the cause, and a probe from a laptop proves
> nothing about Cloudflare Worker egress.

## The sweep, in numbers

```
source_state:  59 sources | 3 never OK | 5 failing now (>=3 consecutive) | 19 ever failed
               re-counted 2026-08-06: rate_boe 46, treasury_auction 20, rate_bcb 16,
               press_cftc_enforcement 10, senate_ptr 3
jobs:          68 jobs    | 3 disabled | 1 quarantined
```

**The plan estimated "~30 dead endpoints and ~10 403s". The real figure is 6
failing of 59.** That gap is not a discrepancy in the plan so much as evidence
that the earlier hygiene passes did their job: the dead endpoints named in the
p4-era sweeps were already fixed, replaced or parked, and their notes are in
`docs/verification/`. Recording the real number so the next session sizes the
work from measurement rather than from a stale estimate.

## Status of every non-healthy source

| Source | State 2026-08-05 | Diagnosis | Action | Dated |
|---|---|---|---|---|
| `rate_boe` | 33 consecutive failures, last OK 2026-08-04T14:33 | **Blocked from Worker egress, NOT a path problem.** The path did move (`/boeapps/iadb/fromshowcolumns.asp` now 302s to `/boeapps/database/_iadb-FromShowColumns.asp`) and the new URL serves 200 + 4,286 bytes **to a residential client**. But the repointed URL deployed at 22:41:22Z and the 23:32Z poll still returned 500, so the host errors Cloudflare Worker egress regardless of path. Same family as treasury.gov 525, cftc.gov 403 and efdsearch 403. | **URL corrected** (the old path really is a 302 to nothing) but the source is **still failing**. Needs a courier route, and whether GitHub-runner egress reaches this host is UNVERIFIED. | 2026-08-05 |
| `bls_jolts` | never OK, 0 failures, 0 polls | **Orphan.** No ingester in `src/`, no row in `jobs`. Never ran; not broken. | **RETIRED** — state row deleted, migration 0065 | 2026-08-05 |
| `treasury_auction` | never OK, 20 consecutive, job quarantined 2026-08-05T21:04:41 | treasury.gov fails the TLS handshake (**525**) from Cloudflare Worker egress. Known and long-documented; this is precisely why the GitHub-runner courier exists. The Worker-side job failing is the EXPECTED half of that arrangement. | **PARKED, working as designed** — the quarantine fired correctly and disabled the job. Data arrives via the courier's `/ingest` path, not this job. | 2026-07-28, re-confirmed 2026-08-05 |
| `press_cftc_enforcement` | never OK, 10 consecutive | `www.cftc.gov` returns **403** to Worker egress while answering the same declared UA from a residential connection. Host-specific: SEC and FTC succeed in the same tick. | **PARKED with a live probe** — left registered on a daily poll so it self-recovers if the block lifts. Documented in `regulatoryPress.ts`. | 2026-07-28 |
| `senate_ptr` | 3 consecutive, last OK 2026-08-02T13:30 | **The "two polls in three" rate in the prior entry was invented from three samples on one Sunday, two of them residential, and is withdrawn.** The real state as of 2026-08-06: cause UNKNOWN, because this was the only polling ingester that never called `recordSourceError`, so `last_error` is NULL after three failures. Fixed in [#155](https://github.com/sahilsapra391/skeptic-persona/pull/155): all four branches now record, and the agreement step no longer gates the search (the eFD data endpoint answered a csrftoken-only jar 27/27 from a residential client, so a handshake regression fits three-for-three deterministic failures better than intermittent 503s). | **INSTRUMENTED, awaiting the next poll.** The 13:30Z slot is the falsifiable test: cards, or a `last_error` that finally says why. | 2026-08-06 |
| `rate_bcb` | **16 consecutive**, last OK 2026-08-05T21:04 | "no non-future observation" on every poll since. The 2026-08-05 entry called this TRANSIENT on the strength of ONE failure that recovered the same day; sixteen in a row is not transient and the old classification was measuring a blip. The error text is our own parser refusing a series with no past-dated row, so this is a DATA-SHAPE problem at the source, not egress — the fetch is succeeding. | **RECLASSIFIED: failing, cause not yet diagnosed.** Needs a look at what the BCB series actually returns now. Not fixed in the wrap sprint (fixed scope); recorded as D-44. | 2026-08-06 |
| `sec_form25` | 1 consecutive, 39 lifetime, last OK 2026-08-05T22:26 | Fetch timeouts against EDGAR under load. Recovered within minutes; the lifetime count is the honest signal that this one is flaky rather than broken. | **TRANSIENT, monitored** — `total_failures` is the trend to watch | 2026-08-05 |

## Disabled jobs, and why

| Job | Why disabled | Dated |
|---|---|---|
| `poster` | Threads account banned; publishing is manual on X. `THREADS_PARKED` in `poster.ts` outranks the env var. | 2026-07-28 |
| `threads_token_refresh` | Same parking. Nothing to refresh while the account is banned. | 2026-07-28 |
| `treasury_auction` | Auto-quarantined on 20 consecutive failures (see table above). | 2026-08-05 |

## The rule this file encodes

A source may be **fixed**, **replaced**, **parked** (temporarily unreachable,
still probed, expected to recover) or **retired** (gone for good, state
removed). It may not be none of those. If a source is failing and is not in
this table with a date, that is itself the defect.
