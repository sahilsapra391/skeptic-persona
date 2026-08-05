# P5 LEDGER — World Coverage Program

Ledger of record for [SKEPTIC-WIRE-P5-WORLD-COVERAGE-PLAN.md]. Every chunk in
the plan appears here with a status. A chunk may be blocked or parked; it may
never be absent. Defects found mid-build are added here immediately, never
fixed silently and never deferred silently.

Statuses: `pending` / `in-progress` / `merged-verified` / `blocked-owner` /
`blocked-gate` / `parked(reason)`.

Chunk numbering in the plan is sparse by design (p5-01..06, 10..13, 20..25,
30..34, 40). The gaps are phase boundaries, not missing chunks. Twenty-two
chunks exist in total.

Last reconciled against production D1: 2026-08-04.

## Gate state (checked, not assumed)

| Gate | Required | Measured in production | Source |
|---|---|---|---|
| Manual-post counter | >= 10 for Phase 2 | **0** | `post_log WHERE posted_manually=1` = 0; `cards WHERE posted_state IN ('yes','modified')` = 0 |
| Phase 0 complete | all 6 merged-verified | 0 of 6 | this ledger |

Phase 2 and beyond are `blocked-gate` until BOTH clear. The counter moves
through the owner's thumbs, not through code.

## Phase 0 — Owed work (no gate, blocks everything)

| Chunk | Scope | Status | PR | Verification |
|---|---|---|---|---|
| p5-01 | Regenerate becomes append-only; history retrievable | in-progress | — | — |
| p5-02 | Branch protection + a main CI run | pending | — | — |
| p5-03 | REGULATORY_NEWS salience tier; drain pending cards | pending | — | — |
| p5-04 | Polish bundle: attribution join, raw ISO in copy, PRODUCT_RECALL length window, over_budget split | pending | — | — |
| p5-05 | TTL-lake measurement; re-card policy decision | pending | — | — |
| p5-06 | Weekly digest north-star block (approval rate, post rate) | pending | — | — |

Phase 0 acceptance: all six merged-verified AND the weekly digest shows the
two rates. No Phase 2 branch may be created before this.

## Phase 1 — Access and hygiene

| Chunk | Scope | Status | PR | Verification |
|---|---|---|---|---|
| p5-10 | Courier consolidation: EDGAR Archives through the Worker courier | pending | — | — |
| p5-11 | Source hygiene sweep: ~30 dead endpoints, ~10 403s fixed/replaced/retired | pending | — | — |
| p5-12 | Senate eFD arrival-latency measurement forward; weekly digest line | pending | — | — |
| p5-13 | Owner memos, no build: (a) NSE/BSE license, (b) Bluesky app password | pending | — | — |

## Phase 2 — Gate-cleared expansion

All `blocked-gate` (needs 10 manual posts + Phase 0 complete). Two are also
`blocked-owner` on a ruling that no session may answer.

| Chunk | Scope | Status | PR | Verification |
|---|---|---|---|---|
| p5-20 | Company voice, EDGAR-native 8-K item 2.02 earnings lane (EVENT only, no figures) | blocked-gate | — | — |
| p5-21 | PR wire re-probe: GlobeNewswire, PR Newswire, ACCESSWIRE | blocked-gate | — | — |
| p5-22 | Geopolitics official-statements lane | blocked-gate + blocked-owner (decision 1) | — | — |
| p5-23 | China official-English lane | blocked-gate + blocked-owner (decision 2) | — | — |
| p5-24 | Commodities beyond energy: USDA WASDE | blocked-gate | — | — |
| p5-25 | Bluesky polling lane | blocked-gate + blocked-owner (decision 5) | — | — |

## Phase 3 — Deep lanes

| Chunk | Scope | Status | PR | Verification |
|---|---|---|---|---|
| p5-30 | IPO/S-1 lane with amendment tracking | blocked-gate | — | — |
| p5-31 | Proxy-contest lane; 13D cross-reference from our lake | blocked-gate | — | — |
| p5-32 | XBRL financials lane; earnings numbers become licensed facts | blocked-gate | — | — |
| p5-33 | TOPIC namespace, then DEVICE taxonomy, then VOICE growth | blocked-gate | — | — |
| p5-34 | Non-US corporate filing systems | blocked-gate + blocked-owner (decision 4) | — | — |

## Phase 4 — Exclusions register

| Chunk | Scope | Status | PR | Verification |
|---|---|---|---|---|
| p5-40 | Create docs/EXCLUSIONS.md; each entry: what, why, what would reopen it | pending | — | — |

## Owner decisions (owner alone; no session answers these)

| # | Decision | Plan's lean | Status | Blocks |
|---|---|---|---|---|
| 1 | Geopolitics official-statements lane: in or out | in, narrow list | blocked-owner | p5-22 |
| 2 | China official-English lane: in or out | in, lag disclosed | blocked-owner | p5-23 |
| 3 | NSE/BSE license: buy or park | park | blocked-owner | p5-13(a) memo informs it |
| 4 | Non-US corporate filings: park or rank one | park | blocked-owner | p5-34 |
| 5 | Bluesky app password: set it or lane stays frozen | — | blocked-owner | p5-25 |

## Owner tasks (hands, not rulings)

| # | Task | Status | Blocks | Note |
|---|---|---|---|---|
| O-1 | INSTITUTIONAL_13F exemplars (2-3, each fits 280, owner's own hand) | blocked-owner | 13F cards through the Aug-14 flood | Days away. No session generates placeholder exemplars. |
| O-2 | Commentary exemplar rewrite (all seven current run 296-354; none can ship) | blocked-owner | every commentary variant | Verified: docs/verification/2026-08-02-commentary-floor.md |
| O-3 | Post ten Copy/Modified posts | blocked-owner | ALL of Phase 2-4 | Counter measured at 0. This is the binding constraint of the program. |

## Defects found mid-build

| ID | Found | Defect | Status |
|---|---|---|---|
| D-1 | p5-01 | Regenerate deleted generation history: production `generations` holds 47 rows but `MAX(id)`=96, so ~49 prior drafts were destroyed and are unrecoverable. Pre-existing rows cannot be restored; p5-01 stops further loss. | fixed in p5-01 |
| D-2 | p5-01 | The attempt budget was coupled to the delete: `attemptsLeft = MAX_ATTEMPTS - MAX(attempt)` over the row's whole lifetime, so append-only without a per-cycle budget would make every regenerated row fall straight to the template. Fixed inside p5-01, not deferred. | fixed in p5-01 |
| D-3 | p5-01 | The card-Edit reply (`webhook.ts`) ran the SAME `DELETE FROM generations` as Regenerate. The plan names only Regenerate, but p5-01's acceptance is "prior valid drafts never deleted", which a second live delete path would fail. Fixed in the same PR. | fixed in p5-01 |
| D-4 | p5-01 | `buildCard` and `resolveVariantText` read valid drafts unscoped by cycle. Harmless while history was deleted; under append-only the card would BLEND cycles, pairing a discarded commentary with the live dry and presenting the mix as one draft set. Kill-test added. | fixed in p5-01 |
| D-5 | p5-01 | `collisionCheck`'s repetition corpus (last 40 valid skeletons across rows) would silently tighten once superseded drafts stopped being deleted: a shape the owner threw away would block a new draft, and the 40-row window would span fewer distinct items than it claims. Scoped to live cycles. | fixed in p5-01 |
| D-6 | p5-01 | `test/generate.test.ts` "does nothing unconfigured" depends on the untracked local `.dev.vars`. With a real `OPENROUTER_API_KEY` present it makes 2 live-path calls and FAILS; in CI the file is absent so it passes. The test has therefore never exercised the unconfigured path it is named for, and the local suite is red on main. Verified red on clean main, both in isolation and in the full file. NOT fixed here: out of p5-01's scope and it belongs with the CI-integrity chunk. | pending (assigned to p5-02) |

## Reconciliation notes

- 2026-08-04, program start. Production D1: 1,065 cards (919 expired, 134
  pending, 11 approved, 1 rejected); approvals counted as
  `queue.state='approved'` UNION `post_log` = 11 + 18 = 29, zero overlap.
  The plan's snapshot said 29 approvals from 1,064 cards. Consistent; one
  card has been created since. No conflict, nothing to escalate.
- The 18 `post_log` rows are Threads-era AUTOMATED posts (2026-07-27 to
  2026-07-28, all `posted_manually=0`), not manual X posts. They count as
  approvals and do NOT count toward the 10-post gate. The plan's "zero
  posts" refers to manual X posts and is accurate.
- Plan p5-03 says "the 133 pending cards"; production measures 134. Drift
  from the snapshot, not a discrepancy. p5-03 drains whatever the count is
  on the day it runs.
