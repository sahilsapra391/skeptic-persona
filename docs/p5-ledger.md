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
| p5-01 | Regenerate becomes append-only; history retrievable | merged-verified | [#133](https://github.com/sahilsapra391/skeptic-persona/pull/133) | [2026-08-04-p5-01](verification/2026-08-04-p5-01-append-only-regenerate.md) |
| p5-02 | Branch protection + a main CI run | blocked-owner (D-10) | — | — |
| p5-03 | REGULATORY_NEWS salience tier; drain pending cards | blocked-owner (D-13) — mechanism + BEA/ONS ruling merged; drain not achievable from that ruling | [#136](https://github.com/sahilsapra391/skeptic-persona/pull/136) | [2026-08-05-p5-03](verification/2026-08-05-p5-03-regulatory-news-tier.md) |
| p5-04 | Polish bundle: attribution join, raw ISO in copy, PRODUCT_RECALL length window, over_budget split | merged-verified | [#137](https://github.com/sahilsapra391/skeptic-persona/pull/137) | [2026-08-05-p5-04](verification/2026-08-05-p5-04-polish-bundle.md) |
| p5-05 | TTL-lake measurement; re-card policy decision | merged-verified (measurement delivered; policy is owner decision 6) | [#138](https://github.com/sahilsapra391/skeptic-persona/pull/138) | [2026-08-05-p5-05](verification/2026-08-05-p5-05-ttl-lake-measurement.md) |
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
| 6 | Re-card policy for expired cards (raised by p5-05, not in the plan's original five) | (c) give expired items the promote path digested items already have | blocked-owner | nothing; expiry stays terminal until ruled |

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
| D-7 | p5-01 code review | The transient-API-error retry guard still read the GLOBAL `MAX(attempt)` after the budget moved per-cycle. In any cycle above 0 the condition is false forever, so the FIRST transient 429/5xx after a Regenerate would write a terminal template row instead of retrying: finding #9's permanent-downgrade regression, reintroduced for every regenerated row and silent. Caught in review, not in tests, because no test exercised a transient failure above cycle 0. Fixed, and the missing test added. | fixed in p5-01 |
| D-8 | p5-01 code review | The card-Edit batch guarded the `regen_cycle` bump on `state IN ('approved','edited')` but deleted the `cards` row unguarded, so a row that failed the guard lost its card without opening a cycle and delivery re-sent the identical card while the owner was told the edit was accepted. | fixed in p5-01 |
| D-9 | p5-01 code review | `GET /admin/generations` had no LIMIT, on the endpoint whose use case is precisely the most-regenerated rows. Bounded to 120 rows with an explicit `truncated` flag. | fixed in p5-01 |
| D-10 | p5-01 merge | **GitHub Actions CI is `disabled_manually`.** `.github/workflows/ci.yml` is present on main and unchanged, but the workflow is disabled at the repo level, so NO pull request has been tested by CI since run 30964438778 (2026-08-05 00:48). PR #133 shows only a Workers Builds check. The plan's p5-02 premise ("116+ merges with no main CI") is understated: there is currently no CI on any branch. Not re-enabled unilaterally, because disabling was a manual act with Actions-minutes cost implications the owner may have intended (ci.yml's own comment cites account-wide private-repo minutes). **Owner decision needed.** | blocked-owner (feeds p5-02) |
| D-11 | p5-01 merge | Migration number collision, mine: I created `0060_generation_cycles.sql` while unmerged main already carried `0060_form13f.sql`, because my branch point predated the 13F lanes. Caught before merge. Renumbered to `0063_generation_cycles.sql`, and the production `d1_migrations` row was renamed to match so wrangler does not re-run it (a re-run would fail on duplicate column and block every later migration). Verified: `migrations list --remote` reports no pending migrations. | fixed in p5-01 |

| D-12 | p5-01b | **Mine, and it reached main.** PR #134's `git add -A` committed 21 duplicate `<name> 2.ext` files that local git tooling had left in the working tree. Most were inert (the test copies do not end in `.test.ts`, so vitest never collected them), but `.github/workflows/thirteenf-backfill 2.yml` registers a SECOND workflow on the same cron, which would have run the 13F backfill twice. Removed in #135, every canonical counterpart verified still present, and `.gitignore` now blocks the pattern. Third recurrence in one session: a stash/pop produced two, a rebase produced four more, and those four broke local test collection by running `CREATE TABLE filings_13f` twice. | fixed in p5-01b |

| D-13 | p5-03 | **Plan intent vs measured reality, reported rather than resolved.** p5-03's acceptance is "tier REGULATORY_NEWS per the BEA/ONS ruling" AND "drain the 133 pending cards through it". The first is done. The second does not follow from the first: applied faithfully, the ruling touches **1 of the 80 pending REGULATORY_NEWS cards**, because ONS has never carded at all (10 items, all `logged`) and BEA has one. The flood is DOJ 25, Bank of Japan 14, SEBI 11, RBI 8 = 58 of 80, none of which is a data print or a release calendar. Tiering those is the editorial call the p4 session refused, and the handoff's suggested shortcut (promote regulatoryPress.ts's prose grouping) is unusable: "GLOBAL WIRE FANOUT, batch 1" records when a URL was probed, so promoting it would rank DOJ enforcement below Bank of Japan press releases. Owner ruling needed on the four sources; the mechanism to act on it is already built and tested. | blocked-owner |

| D-14 | p5-03, self-caught | **My own wrong claim, corrected loudly.** The p5-03 verification doc first stated the tier moves the pending BEA card "70 -> 55". It does not. `salienceFor` is called from one place, `pipeline/enqueue.ts`, at enqueue time; no path re-scores an existing queue row. The tier therefore changes **zero** of the 134 pending cards and applies only to items enqueued from now on. Caught during deployed verification, before the chunk was reported complete. Corrected in the doc with the reasoning, because the error made the drain look numerically small when it is actually structurally impossible: "drain the pending cards through it" needs a retroactive re-score pass that does not exist, and building one would move cards the owner has already seen. | fixed (doc corrected) |

| D-15 | p5-04 | `reg.headline` renders `factLine`, which the ingester builds as `"{authority}: {title}"`, so with attribution appended the authority appears THREE times: `"Bank of Japan: Bank of Japan Accounts (July 31), per the Bank of Japan"`. Distinct from the `reg.authorityFirst` duplication fixed in p5-04. Owner ruled p5-04 stays minimal, because fixing it means either changing the ingester's `factLine` or teaching the render join that a head line may already name its source, and the latter changes how attribution attaches (persona.md section 6). | parked(owner ruled p5-04 minimal) |
| D-16 | p5-04 | **A copy-ready production draft carried a raw ISO timestamp**: `"Published 2026-08-04T01:00:00.000Z."` The p4 session predicted this as "exit #2" of the ISO defect but never observed it. The template engine does not run `numberCheck` at enqueue, so a template fallback hands the owner that string to paste. Also found a SECOND offending beat (`recall.lag`) that prior analysis had not named. | fixed in p5-04 |

### Known and accepted, recorded rather than fixed

| ID | Item | Why it stands |
|---|---|---|
| K-1 | `row.regen_cycle` is read at picker time and used for writes up to `RUN_TIME_CAP_MS` later, so a Regenerate landing mid-run stamps drafts into the superseded cycle. | Self-healing: the delivery join finds nothing at the new cycle, and the next tick re-picks the row with a full budget. Strictly better than main, where the same race deleted generations mid-run and could deliver a card built from pre-edit text. Cost is one wasted LLM run. Closing it properly means a compare-and-set on the cycle at write time. |
| K-2 | Two different counters are both called "cycle": `cards.cycle` / callback-data cycle is `MAX(generations.id)` (a staleness token), `generations.cycle` / `queue.regen_cycle` is the generation pass. | Renaming reaches the callback_data wire format and its 64-byte cap plus the stale-button semantics across webhook.ts and deliver.ts. Bigger and riskier than the chunk it would ride in. Follow-up. |

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
- 2026-08-04, during p5-01: main advanced 7 commits past this session's
  branch point (0579ff5 to f2e1f6f) with the 13F lanes (#129, #130, #131),
  two doctrine fixes (#126, #128), and the courier finding (#132). p5-01 was
  rebased onto it; suite 1017 passing, 1 pre-existing failure (D-6). No new
  `generations` reader arrived with that work, so p5-01's cycle scoping is
  still complete. Migrations 0060-0062 (13F) were already applied to
  production at 00:38, and all four 13F tables exist. No merged-not-migrated
  gap there.
- The `thirteenf-backfill` workflow run on main FAILED at 00:38 with
  `forwarded=0 failed=74`: every EDGAR Archives fetch from the GitHub runner
  returned HTTP 403. This is not a new defect. It is the finding already
  recorded and merged as #132, and it is exactly what **p5-10** (route EDGAR
  Archives through the Worker courier) exists to fix. Consequence worth
  stating plainly: **13F backfill ingests nothing until p5-10 lands**, and the
  plan flags an Aug-14 13F flood. p5-10 is in Phase 1, which is not
  gate-blocked, so it can proceed on schedule.
