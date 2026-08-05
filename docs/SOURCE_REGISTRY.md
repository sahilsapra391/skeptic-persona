# Source registry: every source that is not simply working

**Purpose (p5-11):** *"Nothing rots silently."* Any source that is failing,
parked, quarantined or retired appears here with a **status and a date**. A
source missing from this file and missing from the failure list below is
working; there is no third state.

**Last swept:** 2026-08-05, against live `source_state` and `jobs`.

## The sweep, in numbers

```
source_state:  59 sources | 3 never OK | 6 failing now | 19 ever failed
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
| `rate_boe` | 32 consecutive failures, last OK 2026-08-04T14:33 | **Endpoint moved.** `/boeapps/iadb/fromshowcolumns.asp` now returns 302 with 0 bytes to `/boeapps/database/_iadb-FromShowColumns.asp`, which serves 200 and 4,286 bytes of identical CSV. The in-source note blaming an overnight IADB maintenance window was true when written but stopped explaining a 32-failure streak. | **FIXED** — URL repointed at the final path, parser unchanged | 2026-08-05 |
| `bls_jolts` | never OK, 0 failures, 0 polls | **Orphan.** No ingester in `src/`, no row in `jobs`. Never ran; not broken. | **RETIRED** — state row deleted, migration 0065 | 2026-08-05 |
| `treasury_auction` | never OK, 20 consecutive, job quarantined 2026-08-05T21:04:41 | treasury.gov fails the TLS handshake (**525**) from Cloudflare Worker egress. Known and long-documented; this is precisely why the GitHub-runner courier exists. The Worker-side job failing is the EXPECTED half of that arrangement. | **PARKED, working as designed** — the quarantine fired correctly and disabled the job. Data arrives via the courier's `/ingest` path, not this job. | 2026-07-28, re-confirmed 2026-08-05 |
| `press_cftc_enforcement` | never OK, 10 consecutive | `www.cftc.gov` returns **403** to Worker egress while answering the same declared UA from a residential connection. Host-specific: SEC and FTC succeed in the same tick. | **PARKED with a live probe** — left registered on a daily poll so it self-recovers if the block lifts. Documented in `regulatoryPress.ts`. | 2026-07-28 |
| `senate_ptr` | 3 consecutive, last OK 2026-08-02T13:30 | Intermittent by nature: eFD 503s a datacenter-class client roughly two polls in three. Measuring this properly is **p5-12**, which exists for it. | **WATCH** — no action in this chunk by design | 2026-08-02 |
| `rate_bcb` | 1 consecutive, last OK 2026-08-05T21:04 | "no non-future observation" — the series had no past-dated row at that poll. Self-recovering, and it recovered the same day. | **TRANSIENT** — no action | 2026-08-05 |
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
