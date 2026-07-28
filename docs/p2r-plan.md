# P2-R — Threads park + X commentary pipeline

**Owner-approved 2026-07-28.** Supersedes the P2 Threads-poster plan.

## Why this replan

Meta banned the Threads account (@skeptictradess) on suspected bot activity;
the profile is inaccessible and the read API began returning generic `code 1`
errors around 03:00Z on 2026-07-28. Publishing worked as late as 01:07Z and the
error is not code 190, so this is the ban rather than a token failure.

New model: the pipeline ingests, dedupes, scores and queues exactly as built;
the owner approves in Telegram; an LLM step turns the approved item into a
ready-to-post commentary piece grounded in the parsed payload; the owner copies
it and posts manually to **X (@SkepticTrades)**.

Everything upstream of publishing survives untouched. P1 and P3 (22 ingesters,
dedup ledger, lookback engine, dispatcher, Telegram queue) are
platform-agnostic and are not in scope here.

## The end goal, stated precisely

**A post the owner copies and pastes to X with zero edits.** An opinion piece
with voice, nuance and a real point of view — not a wire line plus a beat. The
`commentary` variant is the primary deliverable. `dry` and `sharp` are
fallbacks, not the reverse.

This inverts the usual risk ordering, deliberately: the value of the whole
pipeline is unproven until commentary holds, so commentary ships in the same
PR as the other two and carries the strictest gates rather than being deferred
behind them.

---

## Corrections applied to the inherited plan

Four changes, all owner-accepted.

**1. Park Threads, do not strip it.** The inherited plan called for removing
every Threads and Meta identifier from the repo. Rejected: an appeal is
outstanding, `post_log` holds 18 real Threads post IDs that a strip would
orphan, and rebuilding OAuth plus refresh plus quota plus claim reconciliation
is days of work for no benefit. Follows the migration 0024 Treasury precedent.

**2. No vector index.** The inherited plan indexed the competitor corpus into
Vectorize and retrieved masked skeletons by archetype. Measurement killed it:
masking collapses 19,518 usable posts to 19,184 distinct skeletons, and
archetype coverage is 4 posts for 8-K and 2 for Treasury auction. Retrieval
would return nothing for most archetypes and silently fall back to geopolitics
shapes. Replaced with a hand-distilled static style pack, deterministic
selection by archetype. See `verification/2026-07-28-competitor-topic-engagement.md`.

**3. Reuse `checkRegister`, do not rewrite the never-list.** The inherited plan
proposed a fresh regex bank. `src/templates/validate.ts` was recalibrated on
2026-07-27 after bare-word matching produced 3 false positives and 0 true ones
("filed notice to sell", "coming up short", "leveraged funds net short" are all
factual). A fresh bank reintroduces exactly that bug. **This lesson generalizes
to every new check in this plan: match constructions, never bare words.**

**4. The echo check is possible.** The inherited plan called it impossible
because no verbatim third-party text is stored. Store salted 8-gram *hashes*
instead: no third-party text in the repo, check still runs.

---

## Part A — Park the Threads publish path (`p2r-01`, migration 0026)

- `runPoster` returns early behind a parked-platform guard; the publish call,
  quota guard and token-invalid alerting stop firing.
- `reconcileClaims` short-circuits. With the account gone its `listRecentPosts`
  read fails every run and writes noise into `source_state.last_error`. It
  already fails safe, so this is hygiene, not a bug fix.
- `refreshThreadsToken` disabled; the token dies 2026-09-25 regardless.
- OAuth routes removed from the worker's fetch handler.
- `threads_token_refresh` deleted from the `jobs` table (migration 0026).
- `src/lib/threads.ts`, `src/threadsOauth.ts` and the publish half of
  `src/poster.ts` stay on disk with a dated header recording the ban, the
  appeal, and what to re-enable if it succeeds.
- The four egress failure modes are parked on the `senate_ptr` daily-probe
  pattern so they self-recover. If Threads returns from appeal, the same shape
  applies.

Acceptance: suite green; scheduler runs with the Threads job absent; the 18
historical `post_log` rows still resolve; no network call to any Meta host on
any code path.

## Part B — Retarget post length to X (`p2r-02`)

`THREADS_TEXT_LIMIT = 500` is referenced by `src/templates/render.ts`,
`src/templates/validate.ts` and `src/templates/index.ts`. X is 280, and t.co
counts every link as 23 regardless of real length.

Renamed to `POST_TEXT_LIMIT = 280` with link accounting. This changes rendering
behaviour for all 22 ingesters and touches files the ingestion session
co-owns, so it is its own PR rather than being folded into Part A.

**Known consequence:** the ~48 already-queued rows have `draft_text` rendered
under the 500 limit and some will exceed 280. They are the fallback path in
Part D, so this is handled at generation time (re-render or truncate-with-
refusal), not by rewriting history.

## Part C — The style pack (`p2r-03`)

One committed file, `src/rag/stylepack.ts`, imported as a static string. No
network, no index, no embedding. Three parts:

**C1. The three moves**, distilled from the corpus rather than retrieved:

- *Compression* (spectator_index, 94-char median): subject, verb, number,
  stop. No adjectives, no hedges, no throat-clearing.
- *Juxtaposition* (unusual_whales): two parsed facts placed adjacent with zero
  connective tissue and no claim joining them. This is already persona.md
  section 3b, "the reader finishes the sentence." It is the signature move and
  the only one that produces edge without producing a sentence that could be
  called fabrication.
- *Attribution as furniture*: they write "per FORTUNE", we write "per SEC".
  Same structure, opposite epistemics.

**C2. The anti-corpus.** Negative examples with the reason each is banned:
"per <outlet>" secondary sourcing, "BREAKING:" on routine items, long/short
calls, motive imputation, image-dependent captions. This is where the other
19,000 posts earn their keep.

**C3. VOICE.** persona.md core, the gated beat libraries from
`src/templates/archetypes.ts`, and the owner-authored exemplars. These are the
only complete posts the model ever sees.

Built **congress-first**: PTR is the only archetype with real style coverage
(154 posts), the best-measured topic (1.67x), and the signature named by
persona.md section 7. Every other archetype gets the three general moves.

## Part D — Generation and validation (`p2r-04`, migration 0027)

Fires on the Approve tap. `enqueueForApproval` signature is unchanged and the
template engine is untouched; `draft_text` becomes the fallback when every
variant fails validation, which makes the template engine more load-bearing,
not less.

Provider: **OpenRouter**, model configurable. The extra hop is deliberate —
model portability is worth more than one fewer dependency, and the persona
must not be locked to a single provider.

Prompt: persona core, the gated beats this payload actually satisfies, the
style pack, the anti-corpus, and the parsed payload as strict JSON with **all
derived figures pre-computed as fields**. The model never does arithmetic.
Three variants in one structured call.

### The commentary contract

`commentary` must read as though a sharp trader wrote it:

- opinionated, with an actual point of view
- structurally sound per persona.md section 3: fact block first with
  attribution, then the take, never blended
- 200–280 characters
- no hedging
- no bot cadence
- no phrasing that repeats across posts

### Validators (`src/rag/validate.ts`)

Every variant is checked before the owner sees it; a failure drops that variant
and regenerates once. Group 1 is the no-fabrication floor and applies to all
three variants. Group 2 is the commentary contract and is strictest on
`commentary`.

**Group 1 — no fabrication (all variants):**

| check | rule |
|---|---|
| number | every numeric token in the draft exists in the payload, normalized across `1,200,000` / `$1.2M` / `1.2 million` |
| entity | every ticker, person and company named exists in the payload |
| attribution | a `per <SOURCE>` matching `payload.source` |
| never-list | `checkRegister()`, reused not rewritten |
| structural law | the sourced fact precedes any take and the first line stands alone as evidence |
| length | 280, minus 23 if a link rides along |

**Group 2 — the commentary contract:**

| check | rule |
|---|---|
| skeleton collision | mask the draft to a skeleton (same masking as the corpus study), hash, compare against the last 40 posted skeletons. Collision rejects. |
| opener collision | first four content tokens vs the last 20 posts |
| template echo | 8-gram overlap against **our own** rendered `draft_text` for the same item. If commentary shares an 8-gram with the template it is the template wearing a coat of paint. |
| corpus echo | salted 8-gram hash overlap against the competitor corpus. Style is imitable; phrasing is not. |
| hedging | hedge *constructions*, not bare words |
| cadence | reject uniform sentence lengths and the three-parallel-clause corporate triad |

The hedging check is the one most likely to repeat the bare-word mistake: "may"
is a hedge in "may prove decisive" and a quotation of the record in "prior
financials may not be relied upon". It matches constructions only, and ships
with the false-positive corpus as test fixtures.

Everything fails closed to the template draft.

## Part E — Copy-out and posted capture (`p2r-05`, migration 0028)

Second Telegram card carrying all three variants. Buttons: `Copy commentary` /
`Copy sharp` / `Copy dry` / `Regenerate` / `Edit`. Copy returns a fenced code
block for one-tap mobile copy.

Then `Posted? Yes / Modified / Skipped`. `Modified` captures the owner's final
text into `post_log.final_text`. Without this, manual posting leaves the DB
blind and both dedup and the nightly Ledger lose ground truth.

## Part F — The learning loop (`p2r-06`)

`(draft, final)` pairs stored. Monthly digest of which phrasings get cut, which
get added, and which edge level actually ships. Owner-approved finals promote
into VOICE above the seed exemplars, weighted higher. The P6 autonomy counters
are repurposed: a category graduates to "ships unedited" rather than to
auto-posting, which is the real quality signal once publishing is manual.

Zero-edit rate on `commentary` is the pipeline's headline metric.

---

## Sequence

| PR | scope | migration |
|---|---|---|
| p2r-00 | this plan + the engagement measurement record | — |
| p2r-01 | park the Threads publish path | 0026 |
| p2r-02 | retarget post length 500 -> 280 for X | — |
| p2r-03 | style pack, congress-first | — |
| p2r-04 | generation + both validator groups, all three variants | 0027 |
| p2r-05 | Telegram copy-out + posted capture | 0028 |
| p2r-06 | learning loop + weekly digest | — |

Migrations **0026–0030** are reserved for this track. The ingestion session
renumbered its open work to 0031+ and starts there.

## Owner tasks

1. **The 8–12 exemplar posts, one per archetype, in the owner's own hand.**
   Blocks `p2r-04` and nothing routes around it: after the style pack these are
   the only complete posts the model ever sees. Congress PTR first.
2. OpenRouter API key.
3. X handle confirmed: **@SkepticTrades**.

## Standing rules, unchanged, enforced differently

No fabrication: every number and entity comes from a parsed field, now enforced
by a validator instead of by a template slot. Every post carries its source
attribution. Primary sources only. No third-party text in the repo or in any
prompt. Never deny automation if asked; never fabricate a human identity; the
skeptic.fyi affiliation stays visible. Fact first, take last, never blended.
