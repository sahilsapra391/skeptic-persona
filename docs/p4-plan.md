# P4 — Global wire + commentary rewire (program of record)

Adopted 2026-08-01. Supersedes the chunk table in the owner's P3 doc
(`SKEPTIC-PERSONA-P3-GLOBAL-WIRE-AND-COMMENTARY-REWIRE.md`, Downloads): that
doc's p3-00..09 numbering collides with the 35 merged p3-NN ingestion chunks,
so new work carries a **p4-NN** prefix. Every owner amendment recorded here
was given in-session 2026-08-01 and is the plan of record; do not re-litigate.

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
| p4-01 | Salience + curation: continuous score = category base × magnitude, bases seeded per-account from `2026-07-28-competitor-topic-engagement.md`; `DAILY_QUEUE_TARGET=25` as a **soft** target; per-category caps overflow into digest cards (Reg SHO nightly joins/leaves first); pushes batch at :00/:30 | 48h replay with composition report; first weekly digest reports composition vs target for retuning |
| p4-02 | WIRE near-dup (Upstash Vector, owner has an account): embed every ingested item at ingest, near-dup query before queueing so one event = one card; hard TTL eviction (14d default, env) | Verification doc FIRST: free-tier vector/request/dimension/namespace limits + hosted embedding models; if the plan does not fit, numbers + cheapest unlock, owner call |
| p4-03 | Source registry + health (B0 adapted onto existing `jobs`/`source_state`, not a re-architecture): registry rows drive polling + the mesh tiers; auto-quarantine after N consecutive fails with recovery probe; `/health` bot command; weekly health digest | Quarantine proven against a deliberately dead URL |
| p4-04 | Discovery mesh FAST tier (1 min): PR wires (Business Wire, PR Newswire, GlobeNewswire, ACCESSWIRE), Bluesky curated-author + keyword polling (public read endpoints, poll not firehose) | [VERIFY] Bluesky unauthenticated vs app-password read limits; per-tick subrequest/CPU math vs Workers Paid in the PR |
| p4-05 | Mesh MEDIUM tier (5–15 min): GDELT, Google News RSS query feeds, outlet RSS (Reuters, AP, CNBC, FT, Nikkei, Economic Times, Moneycontrol + the owner-signed list), public Telegram channels via `t.me/s/` HTML | Live-verify record per source |
| p4-06 | Mesh SLOW tier (hourly/daily): remaining B2/B3 fanout — DOJ/SDNY, OCC/FDIC, FINRA revisit, sanctions lists (OFAC/EU/UK OFSI), IMF/World Bank, Eurostat/ONS, India (what is honestly reachable; NSE stays parked) | Live-verify record per source |
| p4-07 | Grounding, decided (G2 + Upstash, four namespaces): D1 structural-records table over all ten archives (LATEST files D1-only); TOPIC namespace (TOP archives, structural metadata + engagement tier ONLY) as a salience prior, never prompt text; DEVICE namespace (~20–30 rhetorical devices distilled via a one-time OpenRouter labeling pass — name, abstract description in our words, trigger conditions, engagement tier, archetype affinity; zero source text, zero reconstructable post ids), 2–3 devices injected into STYLE by payload shape; `SPICE_LEVEL` env 1–3 (default 2) sets device count + beat escalation and NEVER relaxes the never-list; edge targets records/rules/timing/coverage gaps, never motive or character; new validators: 7-gram verbatim-leak check vs a build-time hash set of the TOP archives (archives never ship), template-smell extended to a device's canonical form | Verification doc: device count, engagement distribution per device, 20-record zero-verbatim spot-check, 10 sample generations per spice level — owner reviews before this path goes live |
| p4-08 | VOICE namespace (our posts + `owner_final` exemplars, the ONLY namespace whose verbatim text may reach a prompt; retrieval provenance logged on every draft that used it) + the learning loop ((draft, final) pairs, digest, promotion, ships-unedited counters, zero-edit rate as headline metric) | Promotion works end to end |

Deferred, in owner-blocking order: **full-source grounding** (P3-doc A1 + the
validator-whitelist widening that must land in the same PR) waits until the
owner's exemplars cover more archetypes.

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
2. Sign the outlet list (p4-05) and the Bluesky author/keyword lists (p4-04).
3. Review the spice-level samples before p4-07 goes live.
4. Retune `DAILY_QUEUE_TARGET`/TTLs from the first weekly digest's numbers.

Standing rules unchanged: no fabrication; attribution on every post; primary
sources only; no third-party verbatim in repo or prompts; fact first, beat
last, separable; never deny automation; POSTING_ENABLED stays false; kill
switch honored; one chunk per PR, plan before code, review before done.
