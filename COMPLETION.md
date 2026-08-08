# COMPLETION — Skeptic Wire, P5 program

B-03.1's terminal artefact. Written 2026-08-07 against `main` at the commit
this file lands in. Every number below was read from production D1 or from a
live run, not from memory.

> **CORRECTION, 2026-08-08.** The first version of this file opened by claiming
> the desk had published nothing. **That was wrong, and it was my error.** The
> query behind it selected `created_at` from `post_log`, a column that does not
> exist there (it is `posted_at`); the query errored and my helper reported the
> error as "no rows". I read an instrument fault as a finding — the D-53
> mistake, made after cataloguing it three times in the same session. The real
> figure is **34 manual posts across 7 archetypes, 2026-07-27 to 2026-08-07**.
> Owner task O-3 ("post ten") was already satisfied when I wrote the claim.

The honest headline: **the pipeline works and the desk is publishing.** 34 posts
have gone out manually, which is what the design intends — `POSTING_ENABLED` is
`false` and the `poster` job is disabled, so every one is a human Copy-and-post
tap through the Telegram queue.

---

## 1. What is running

```
sources        64 registered   63 healthy   1 failing
jobs           74 registered   72 enabled   2 deliberately disabled
lake           24,452 items across 60 sources
queue          1,142 expired · 83 pending · 47 approved · 1 rejected
post_log       34 posts across 7 archetypes
```

The two disabled jobs are disabled on purpose: `poster` (publishing is manual;
`POSTING_ENABLED` is `false`) and `threads_token_refresh` (Threads account
banned 2026-07-28, lane parked not deleted).

The one failing source is `rate_bcb`, 53 consecutive failures,
`no non-future observation` — a pre-existing parse issue, not a lane outage.

### Lanes delivering today

Congress (House + Senate), 8-K events and bodies, Form 4, Form 144, Form 25,
Schedule 13D/G, 13F with breakdown cards, halts, Reg SHO, FDA recalls (drug,
device, food), Federal Register, BLS, Treasury, CFTC (enforcement + COT), NOAA,
eleven central-bank rate lanes, twenty-one regulatory-press lanes, two PR wires,
and — new today — S-1/IPO and proxy-contest.

### Lanes built but inert, by design

| Lane | Why |
|---|---|
| `bluesky_discovery` | behind `BLUESKY_ENABLED`; needs `BLUESKY_IDENTIFIER` |
| `poster` | `POSTING_ENABLED=false`; publishing is manual doctrine |
| Threads client | parked after the 2026-07-28 ban |

---

## 2. What the program set out to do, and where each part landed

### Delivered

- **p5-01 … p5-13** — regenerate cycles, branch protection, polish, TTL
  measurement, digest north-star, source hygiene, eFD latency, owner memos.
- **p5-20 / p5-20b** — earnings event lane; XBRL concept resolver
  (`src/ingesters/xbrlFacts.ts`) with the omit rule.
- **p5-21** — both PR wires, as discovery that can never card.
- **p5-30 / p5-31** — S-1/IPO with amendment tracking; proxy contest with a
  13D cross-reference against our own lake.
- **B-05 / B-06** — full exposure response: history purge, secret rotation,
  scanning, Dependabot, fork-PR hardening, `docs/PUBLIC.md`.
- **B-07 / B-08** — the generation-fallback block, in full.
- **B-04.2** — CI diet.

### Delivered by finding it was already delivered

**p5-22 geopolitics.** Owner decision 1 was "in, narrow list". Of eight
candidate bodies, five are dead on two documented paths each, one (UN News) is
live but editorially wrong for this desk, and **the two that matter were
already ingesting** as `press_wto` and `press_eu_commission`. Building the lane
would have produced a second ingester for feeds already flowing.

### Excluded, with reasons on the record

`docs/EXCLUSIONS.md` now carries four entries: NSE/BSE licensing, UN News as a
geopolitics source, the China lane, and the USDA lane. Each names what would
reopen it.

### Blocked, and on whom

| Item | Blocked on |
|---|---|
| p5-24 USDA | a free NASS QuickStats API key (owner) |
| p5-25 Bluesky activation | `BLUESKY_IDENTIFIER` (owner) |
| p5-32 EARNINGS_RESULTS carding | D-52 ruling on three exemplar figures (owner) |
| p5-33 namespaces | the competitor TOP archives are outside this repo (owner) |
| p5-34 non-US filings | owner decision 4 |
| p5-03 drain | D-13 (owner) |
| CI minutes digest line | a GitHub token with actions/billing read (owner) |

---

## 3. The generation pipeline, measured

B-08.7's acceptance, on cards generated after the B-08 deploy:

```
19 cards   18 got a voice   1 fell back   =  5.3% fallback
baseline 36% (10 of 28)     target under 10%     MET
```

19 is one short of the block's "at least 20". Stated rather than rounded up.

**11 of those 19 cards hit `api_error`/`api_failed` and still got a voice.**
Before D-75 split the API budget from the voice budget, those 11 would have
burned their retries on network blips and taken a template. The rate would have
been near 63%.

### What the block actually found

The suspected cause (the aphorism scorer) was not the cause: it fired **once in
48 hours**. The real causes were three, and none had been guessed:

1. **D-73** — `numberCheck` read the `4` in `"per SEC Form 4 filings"` as a
   factual claim. No payload holds a bare 4, so **every variant** of three
   archetypes was rejected on the one string the template must emit.
2. **D-74** — the general form. FILING_FORM4 looked healthy and passed **by
   coincidence**: its payload happens to carry `formType: "4"`. Four more
   latent instances were found by sweeping against a payload with no numbers
   at all.
3. **D-75** — a network blip and a voice rejection shared one budget, so an
   API outage spent a card's voice. And the loop was `round < 2`, making
   `MAX_ATTEMPTS = 4` unreachable.

Then a sweep of the exemplar bank found **six archetypes with zero exemplars,
four of them actively carding — 53 cards had been falling back silently**
(D-86). Twice is a class, so the guard is now a test:
`test/exemplarCoverage.test.ts` fails if any archetype ships with an empty bank.

---

## 4. Discipline that earned its place

- **Endpoint verification is law.** It retired five geopolitics bodies, found
  China and USDA have no machine-readable endpoint, and revealed that p5-22 was
  already built.
- **A live dispatch run before merge (D-48).** It caught the S-1 lane timing
  out on its first production poll (D-82) — a lane that *half-worked*, showing
  rows arriving while later forms were silently never polled.
- **Verify the request before blaming the network (D-71).** The Senate courier
  ran green for five days ingesting nothing. The 503 was not maintenance and
  not an IP block: it was our own courier sending `submitted_start_date=`
  empty.
- **Measure, do not reason.** The 8-K→periodic lag was wrong twice before it
  was right (D-69), and the second wrong answer was mine.

### Mistakes recorded, not buried

D-56 (I rotated one half of a shared secret and a filtered stderr hid the
failure), D-67 (I wrote a flaky timing test inside the PR fixing a timing bug),
D-70 (I diagnosed an IP block that did not exist), D-82 (an N+1 that only a
live run could reveal), D-83 (a `grep -qv` whose BSD/GNU divergence would have
skipped the suite on code). Roughly a dozen of my own drafts failed validation
before install; the aphorism scorer caught my writing three times in one day.

---

## 5. Test and deploy state

```
suite       1,277 passing   1 failing (D-6, fixed on the P6 session's branch)
typecheck   clean
main        deployed; migrations 0069 and 0070 applied after their deploys (D-43)
CI          concurrency + cancel-in-progress; docs-only PRs 0.13 min vs 1.57 baseline
```

---

## 6. What remains

```
post_log:  34 posts, 2026-07-27 .. 2026-08-07, 7 archetypes
queue:     1,144 expired, 47 approved
```

**O-3 is satisfied.** The desk publishes. The expired count is still worth
attention — a card that ages out is one the queue outlived rather than one the
owner rejected — but that is a throughput question, not the existential one the
first draft of this file claimed.
