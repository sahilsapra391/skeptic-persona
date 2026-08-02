# P4 — Global wire + commentary rewire (program of record)

Adopted 2026-08-01. Supersedes the chunk table in the owner's P3 doc
(`SKEPTIC-PERSONA-P3-GLOBAL-WIRE-AND-COMMENTARY-REWIRE.md`, Downloads): that
doc's p3-00..09 numbering collides with the 35 merged p3-NN ingestion chunks,
so new work carries a **p4-NN** prefix. Every owner amendment recorded here
was given in-session 2026-08-01 and is the plan of record; do not re-litigate.

THREE sessions ship into this repo concurrently. Chunk numbers are claimed by
cross-session message BEFORE a branch is cut, and each session works from its
own git worktree (p4: ../skeptic-p4, RAG: ../skeptic-p2r, ingestion: the main
checkout) — a shared checkout let one session's `git add -A` capture
another's uncommitted files on 2026-08-01.

Ground truth at adoption (evidence: `docs/verification/2026-08-01-p4-00-deploy-truth.md`):
the approve→OpenRouter→copy-card pipeline (p2r-04/05/06) is merged, deployed,
and configured but has never made a live LLM call; ~30 sources poll but the
relay-gated congress lanes were dark until p4-00; there is no salience layer;
the account runs Workers Paid (2026-07-27), so budget math is against paid
limits plus 2,000 GH Actions min/month.

## Chunks

| Chunk | Scope | Gate |
|---|---|---|
| p4-00 | Ops unlock: relay schedule on (secrets live-verified), lane-scoped dispatch, senate diagnostics; owner TTLs (48h default / HALT+MACRO_PRINT 12h / CONGRESS_PTR 96h, committed `[vars]`, per-archetype sweep); card honesty fixes (no-exemplar label names the archetype; flushed-card message); freshness tests seed against the Worker's clock | Live congress-PTR e2e recorded in the verification doc |
| p4-00b | (landed) Press attribution map: cite the named regulator; prompt states the resolved citation and leads with commentary | First fully valid generation (queue #918 cycle 30) |
| p4-01 | Grounded generation (owner re-sequenced ahead of salience 2026-08-01 after reviewing cycle 30): `items.raw_text`/`raw_meta` (0043) via ingest capture (press descriptions) + one-time cached politeFetch at generation (official hosts full/24k, others excerpt/1.2k, egress-blocked refused); LAKE CONTEXT lines from our own items table (entity-keyed priors with titles/dates/windows); validator whitelist widened payload ∪ source ∪ context with all bypasses re-proven; prompt demands the take engage the specific record and bans unparsed market-reaction claims | Kill-tests green; live grounded generation recorded in the verification doc |
| p4-02 | Beat quality + OpenRouter round-trip verification (RAG session, PR #69) | beatShapeCheck; round-trip recorded |
| p4-03 | Salience + curation: continuous score = category base × magnitude (bases encode the study's ORDERING only — it forbids its ratios as coefficients); soft daily target with per-category caps overflowing into digest cards; `items.status='digested'` + `digest_items` (0044) + a 21:00 ET roll-up with ↑ promote | **Landed**: replay over all 918 production cards, 153/day → 30.3/day (80.2% reduction), false negatives stated and explained — `docs/verification/2026-08-01-p4-03-salience.md` |
| p4-04 | WIRE near-dup (Upstash Vector, owner has an account): embed every ingested item at ingest, near-dup query before queueing so one event = one card; hard TTL eviction (14d default, env) | Verification doc FIRST: free-tier vector/request/dimension/namespace limits + hosted embedding models; if the plan does not fit, numbers + cheapest unlock, owner call |
| p4-05 | Source registry + health (B0 adapted onto existing `jobs`/`source_state`, not a re-architecture): registry rows drive polling + the mesh tiers; auto-quarantine after N consecutive fails with recovery probe; `/health` bot command; weekly health digest | Quarantine proven against a deliberately dead URL |
| p4-06 | Discovery mesh FAST tier (1 min): PR wires (Business Wire, PR Newswire, GlobeNewswire, ACCESSWIRE), Bluesky curated-author + keyword polling (public read endpoints, poll not firehose) | [VERIFY] Bluesky unauthenticated vs app-password read limits; per-tick subrequest/CPU math vs Workers Paid in the PR |
| p4-07 | Mesh MEDIUM tier (5–15 min): GDELT, Google News RSS query feeds, outlet RSS (Reuters, AP, CNBC, FT, Nikkei, Economic Times, Moneycontrol + the owner-signed list), public Telegram channels via `t.me/s/` HTML | Live-verify record per source |
| p4-08 | Mesh SLOW tier (hourly/daily): remaining B2/B3 fanout — DOJ/SDNY, OCC/FDIC, FINRA revisit, sanctions lists (OFAC/EU/UK OFSI), IMF/World Bank, Eurostat/ONS, India (what is honestly reachable; NSE stays parked) | Live-verify record per source |
| p4-09 | Grounding, decided (G2 + Upstash, four namespaces): D1 structural-records table over all ten archives (LATEST files D1-only); TOPIC namespace (TOP archives, structural metadata + engagement tier ONLY) as a salience prior, never prompt text; DEVICE namespace (~20–30 rhetorical devices distilled via a one-time OpenRouter labeling pass — name, abstract description in our words, trigger conditions, engagement tier, archetype affinity; zero source text, zero reconstructable post ids), 2–3 devices injected into STYLE by payload shape; `SPICE_LEVEL` env 1–3 (default 2) sets device count + beat escalation and NEVER relaxes the never-list; edge targets records/rules/timing/coverage gaps, never motive or character; new validators: 7-gram verbatim-leak check vs a build-time hash set of the TOP archives (archives never ship), template-smell extended to a device's canonical form | Verification doc: device count, engagement distribution per device, 20-record zero-verbatim spot-check, 10 sample generations per spice level — owner reviews before this path goes live |
| p4-10a | The learning loop, D1 only: (draft, final) pairs captured at post time, promotion of owner finals into a `voice_finals` table, finals fed back into the generation prompt, nightly digest with zero-edit rate as the headline metric | Promotion works end to end |
| p4-10b | VOICE namespace in Upstash (similarity retrieval over `voice_finals`, the ONLY namespace whose verbatim text may reach a prompt; retrieval provenance logged on every draft that used it) | Gated on post volume — see the split note below |

Split note (2026-08-01): the learning loop was one chunk paired with an Upstash
VOICE namespace. That was a sequencing error. The loop needs only D1 and the
`post_log.final_text` capture that already ships, and with zero manual posts
recorded there is nothing to retrieve against — a similarity index over an
empty table is a dependency bought for no return. The loop goes first because
it cannot report on days that happened before it existed; the namespace waits
for volume worth retrieving.

Re-sequencing note: full-source grounding was originally deferred behind
exemplar coverage; the owner un-deferred it 2026-08-01 after reviewing the
first valid generation (cycle 30 read machine-made and context-free), and it
landed as p4-01. Exemplar depth remains the open owner task it always was.

## Migration + job-row discipline (agreed across sessions 2026-08-01)

- Claim a chunk number by cross-session message BEFORE cutting the branch.
- Migration ranges: RAG holds 0029-0030; p4 holds 0044-0045; ingestion 0046+.
  A gap is verified-harmless; a duplicate is not.
- A migration may be applied to prod ahead of its merge (they are additive).
  A **job row** may ship `enabled=1` ahead of its handler only when BOTH:
  (a) its cadence profile is already known to the DEPLOYED build, so an early
  pick parks normally instead of falling through the unknown-profile path,
  and (b) the handler lands in the same PR as the migration. `0044_salience`
  violated both and burned a slot per hour until corrected; `0046_source_health`
  violates neither and correctly ships enabled — seeding it disabled would
  trade a bounded logged cost for an unbounded silent one (a source that never
  runs because nobody did the follow-up UPDATE).
- **Nobody runs `npm run deploy`.** Workers Builds auto-deploys on merge in
  28-70s. With three sessions on worktrees, a manual deploy from a feature
  branch silently overwrites main-merged code with unmerged work.
- A cross-branch verification states the SET it covered AND the SHA/time it
  ran at. A nine-of-eleven merge check reads as exhaustive and is not; so
  does a review whose branch moved underneath it. A push to a branch under
  review invalidates that review for the changed PR — say so, and it is re-run.

## Two defect classes with no automated guard (recorded 2026-08-01)

Both were found only because someone went looking. Neither is catchable by
the suite, so they are written down instead.

**1. Locally correct code contradicting a decision recorded elsewhere.**
Three instances in one evening: a health probe re-enabling sources that
migrations 0024/0034 deliberately parked; a migration seeding an enabled job
row whose handler was not in the deployed build; an echo check armed against
a table nobody had loaded. Every individual assertion passes, because a test
asserts one decision at a time.

> The contradiction always runs in the direction of the newer code, because
> the older decision is invisible unless you go looking for it.
> — ingestion session, 2026-08-01

The practical guard, and the only one we have: **when you write code that
re-enables, re-schedules, or re-scores an existing row, first go read why it
is in the state it is in.**

**2. "Correct, and ruinous" — a defect whose only instrument is a cost meter.**
`issuerGate` called a full-table scan once per filing: correct code, correct
answers, ~12,000 rows read per call, ~87M/day against a 5M/day cap. Every
output-based assertion passes forever. The guards that would catch it are all
cost-side — `meta.rows_read` assertions on hot-path queries, an EXPLAIN QUERY
PLAN check that no per-item query reports SCAN, a per-tick budget counter —
and **we currently have none of them.** Recorded so the absence is known
rather than assumed covered.

## Queue-volume rules (owner amendment 2026-08-01, plan of record)

- `DAILY_QUEUE_TARGET` 25 is a **soft** target, never a hard cap.
- **Congress PTRs and enforcement actions are EXEMPT from the daily ceiling.**
  Owner, verbatim: "if a day produces 30 genuinely high-salience items, push
  them and let the low-salience categories absorb the squeeze via digests. A
  hard cap that drops a congress PTR because a quiet category already filled
  the day is the failure mode to avoid." Implemented as `CEILING_EXEMPT` in
  src/salience.ts (CONGRESS_PTR, REGULATORY_NEWS, POLICY_ACTION) plus a
  high-score cap bypass for everything else.
- Per-category TTLs, 48h default: MACRO_PRINT 12h, HALT 12h, CONGRESS_PTR 96h
  (shipped p4-00, committed `[vars]`).
- Report actual composition against the target in the first weekly digest
  after salience lands, and retune from real numbers rather than guesses.

## Mesh rules (owner-set, apply to every tier)

- Social and news items are DISCOVERY, never citation. A mesh item pointing at
  a filing or official release gets the PRIMARY document fetched, parsed, and
  queued with its own attribution. Only GLOBAL_WIRE-class items with no
  underlying document may cite an outlet, named in the post.
- Explicitly out of scope: scraping x.com, nitter/RSSHub X routes, any
  unauthenticated X endpoint, and the forward-to-bot ingester. For filings,
  halts, and macro our primary feeds are FASTER than the X accounts relaying
  them; X only leads on no-filing events, which the mesh covers.
- Every mesh item runs through WIRE near-dup before queueing.
- Bluesky/Telegram items carry a lower salience base than filings and need
  corroboration from a second independent feed to push; single-source social
  goes to digest only.
- Health quarantine applies to every mesh source; nothing retries silently
  forever.

## Upstash fail-open rules (owner-set)

If Upstash is unreachable or similarity is below the floor: WIRE dedup
degrades to exact-hash matching, TOPIC prior falls back to the static category
base, VOICE falls back to the static style pack. A vector call never blocks a
queue push.

## Owner tasks

1. Exemplars for the uncovered archetypes — INSIDER_NOTICE (Form 144) first,
   then OWNERSHIP_STAKE, POSITIONING, PRODUCT_RECALL, POLICY_ACTION. The
   exemplar gate refuses generation per-archetype without them.
2. Sign the outlet list (p4-07) and the Bluesky author/keyword lists (p4-06).
3. Review the spice-level samples before p4-09 goes live.
4. Retune `DAILY_QUEUE_TARGET`/TTLs from the first weekly digest's numbers.

Standing rules unchanged: no fabrication; attribution on every post; primary
sources only; no third-party verbatim in repo or prompts; fact first, beat
last, separable; never deny automation; POSTING_ENABLED stays false; kill
switch honored; one chunk per PR, plan before code, review before done.
