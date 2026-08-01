# p4-00 — Deploy truth, defect reconciliation, relay go-live (2026-08-01)

Answers Part 0 of the owner's P3 doc. Every claim below was verified live
today; commands and run ids inline.

## 1. Deployed Worker vs main: NO deploy gap exists

Cloudflare Workers Builds auto-deploys every merge: each merge on 2026-07-28
(#58–#63) produced a deployment within 30–70 s (`npx wrangler deployments
list`), and PR #64 (merged 2026-08-01T16:22:50Z, remote head 52882a6) deployed
33 s later at 16:23:22Z. The 4-day quiet window 07-28→08-01 was PR #64
sitting OPEN — a merge gap, not a deploy gap. Repo CI (ci.yml) is PR-only
tests with no deploy step; branch pushes get build-checks without deploys.

D1: `npx wrangler d1 migrations list skeptic-wire --remote` → "No migrations
to apply!" — all 40 files (0001–0042) applied; 0029/0030 never existed
(numbering reserved, see p2r-plan.md).

## 2. P2-R chunk status: built, deployed, and never exercised

| Chunk | Merged | Deployed | Live behavior |
|---|---|---|---|
| p2r-01 park Threads (0026) | #47 | 07-28 | poster/threads_token_refresh unregistered; Meta-origin tripwire tests green |
| p2r-02 weighted 280 | #49 | 07-28 | in force |
| p2r-03 style pack | #52 | 07-28 | in force |
| p2r-04 generation + gauntlet (0027) | #54 | 07-28 | job live (every_5m, prio 30); **zero OpenRouter calls ever** (see §3) |
| p2r-05 copy-out card + Posted? (0028) | #60 | 07-28 15:34 | delivered exactly one card (queue #321) |
| p2r-06 exemplars | #61 | 07-28 16:07 | 27 exemplars / 8 archetypes wired; learning loop NOT built (renamed scope; now p4-08) |

Secrets (`npx wrangler secret list`): OPENROUTER_API_KEY present (set 07-28
15:23), TELEGRAM_*, THREADS_* present. `OPENROUTER_MODEL` =
`qwen/qwen3.7-flash` (wrangler.toml) — catalog-verified 07-28, still never
called; the authenticated round-trip owed by
`2026-07-28-openrouter.md` remains owed and lands with the e2e below.

## 3. The four observed defects, explained

Production counts today (before this PR's relay runs): 10,825 items across 35
sources, 39 enabled jobs; queue lifetime: 912 expired / 4 pending / 1
approved / 1 rejected; generations: **1 row ever** — queue #321,
OWNERSHIP_STAKE, `skipped_no_exemplar`, 2026-07-28T16:14Z; post_log manual
posts: 0.

1. **"Approve does nothing useful"** — the approve→generation→card path is
   deployed and works (queue #321 went Approve→card in ~4 min on 07-28). It
   has never produced commentary because every item approved since the
   exemplar bank shipped belonged to an archetype with NO owner exemplar
   (INSIDER_NOTICE, OWNERSHIP_STAKE, POSITIONING, PRODUCT_RECALL,
   POLICY_ACTION); the exemplar gate then correctly refuses the LLM call and
   delivers a template card. Not a deploy gap; an exemplar-coverage gap plus
   two card-copy defects fixed in this PR (the no-exemplar label now names
   the archetype; a flushed card no longer points at a "newest card" that
   does not exist).
2. **"Source coverage is the P1 six"** — false for polled sources (35 in the
   lake) but effectively true for the flagship congress lane: the ingest
   relay had never run once. Three stacked causes, all cleared today: GitHub
   billing failure (every Actions run since 07-28 15:11 failed in 3 s with
   zero steps; owner fixed 2026-08-01), INGEST_SECRET absent from the Worker
   (endpoint answered 503 by design), relay schedule commented out (quota
   reset date was today).
3. **Mechanical noise** — real and unfixed by deployment: no salience layer
   exists (p4-01); Reg SHO queues one card per ticker by design. The
   non-traded-fund 8-K noise specifically was PR #64 sitting unmerged
   07-28→08-01; its issuer-gate absence rule deployed today 16:23Z.
4. **"Expired unapproved" flood** — deployed intended behavior: 6h default
   TTL from the automated era, QUEUE_TTL_HOURS unset (dashboard vars are
   wiped by Workers Builds on every merge deploy). This PR commits the
   owner's manual-posting TTLs in `[vars]`: 48h default, HALT/MACRO_PRINT
   12h, CONGRESS_PTR 96h, per-archetype sweep in one bounded pass.

Also fixed here: `test/housePtrRelay.test.ts` had two tests pinned to a fake
2026-07-28 clock while the `/ingest` path (exercised via SELF.fetch) evaluates
freshness on the Worker's real clock — green when written, red four days
later. Freshness-dependent seeds now derive from the real clock; CI itself
was billing-dead when those merges landed, which is why nothing caught it.

## 4. Relay go-live evidence (run 30710041354, workflow_dispatch, 17:18Z)

- **Secret pair proven end to end**: treasury_auction and
  press_cftc_enforcement lanes POSTed to `/ingest` with the stored secrets
  and got 200 (a mismatch 401s; unset 503s). house lane: pending endpoint
  200, 41 PDFs extracted, `{"ok":true,"inserted":41,"queued":0}`.
- **queued:0 is doctrine-correct**, not a malfunction: the pending list
  drains newest-first and the newest e-filed House PTR in the index is filed
  7/30; its 48h-after-UTC-midnight freshness window closed 08-01T00:00Z,
  ~17h before the run (enabled four days earlier, both 7/30 filings would
  have queued). 248 unread backlog docs remain → ~5 weekday runs to drain,
  all stale→lake (lookback fuel), zero queue impact.
- **First relay-born queue card**: press_cftc_enforcement produced queue
  #918 (REGULATORY_NEWS, exemplar-covered) at 17:18Z.
- **Senate lane PARKED from the schedule** after two diagnostic runs
  (30710419446, 30710496292) from separate GitHub-hosted runners:
  `home=200`, search POST `503` with a bot-mitigation block page, invariant
  to session handling (agreement 302 followed vs not). eFD blocks this IP
  class at the data endpoint exactly as it blocks Cloudflare egress. We do
  not disguise clients; the lane stays manually dispatchable
  (`lane=senate`) awaiting an honest network path (candidate: owner-run
  residential courier POSTing the same bundle to `/ingest`).

## 5. Live end-to-end

### 5a. First live generation — queue #918 (2026-08-01, interim record)

Owner approved #918 (REGULATORY_NEWS, the relay-born CFTC enforcement item)
at ~18:0xZ; the generation job picked it up on its 5-minute tick. **First
OpenRouter call in the project's history.**

- **Mechanics all passed**: `qwen/qwen3.7-flash` returned clean structured
  JSON on both attempts (`2026-07-28-openrouter.md`'s owed authenticated
  round-trip is hereby recorded); grounding held — every token of all six
  drafts exists in the payload, zero fabricated numbers, zero motive
  language; the retry-with-feedback loop ran; the fail-closed chain ended in
  the register-checked template card (cycle 26) with the cycle token
  behaving.
- **All six variants rejected** — five `rejected:attribution`, one
  commentary `rejected:length` (the 280 contract working as designed).
- **Root cause (systematic)**: exemplar–validator contradiction. The owner's
  REGULATORY_NEWS exemplars cite the named body ("per SEC"/"per CFTC"/"per
  FTC"); the validator's allow-list derives from archetype attribution
  strings, and REGULATORY_NEWS declared only the generic "per the issuing
  authority" (archetypes.ts:857 at the time). The model wrote "per CFTC" —
  correct by exemplar, payload, and doctrine — and the gauntlet killed it.
  Every press-item generation was structurally doomed to template fallback.
- **Fix (p4-00b, this record's PR)**: `PRESS_ATTRIBUTION` closed map keyed
  on `payload.authority` (the p3-30 RATE_ATTRIBUTION pattern), wired as the
  archetype's map-form attribution — render cites the named body, unknown
  authority refuses to render, checkRegister with payload accepts ONLY this
  item's citation ("per SEC" on a CFTC order dies). Prompt now states the
  resolved citation verbatim and leads with commentary as THE deliverable.
- Also observed, evidence for the deferred full-source-context work: press
  payloads are title-only, so the model has three facts to write from — take
  quality is bounded by payload depth, not by the model.

**Regeneration under the fixed code (observed 2026-08-01 ~18:4xZ, cycle
token 30):** owner merged p4-00b (deploy 18:34:58Z, 28 s after merge) and
tapped Regenerate; the wipe and re-run were watched live. Result: dry VALID
and sharp VALID on attempt 1; commentary overflowed 280 weighted once
(`rejected:length`) and passed on the designed retry — **all three variants
valid, zero attribution rejections**, card delivered with all Copy buttons.
Owner verdict on quality (drives p4-01): grounded correctly but machine-made
— takes carried unparsed market-reaction claims ("Spreads compress fast.
Retail absorbs the shock.") and filler; commentary needs real context, not
just the three payload facts.

### 5b. Congress-PTR e2e (the owner-specified target)

PENDING Monday: House index rebuild (~13:00 UTC) + the 14:20 UTC house lane
queue fresh weekend/Monday e-filings (senate lane parked, §4). Record lands
here as a docs follow-up on main per owner decision 2026-08-01.
