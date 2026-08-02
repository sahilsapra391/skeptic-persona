# Ingestion lane handoff — 2026-08-02

Written on parking the ingestion session. Everything here was measured against
production D1 or the repo on 2026-08-02, not recalled. Where something is
inferred rather than observed it says so.

> **SOURCE WORK IS STOPPED.** Owner instruction, 2026-08-02: no new sources
> until **10 manual posts are recorded**. The reason is in the numbers below —
> the desk has published nothing in five days, and
> [`2026-08-02-press-volume-vs-ceiling.md`](verification/2026-08-02-press-volume-vs-ceiling.md)
> measures the current 26 press sources at **50–90 uncapped items/day against a
> 25/day target**. Adding sources makes the live problem worse, not better.
>
> Resumption test: `SELECT COUNT(*) FROM post_log WHERE posted_manually = 1` ≥ 10.
> It is **0** today.

## Where the pipeline actually is

```
jobs enabled          63
items in the lake 11,293
cards created        921      (157-170/day last week -> 12 Sat, 3 Sun after salience)
posts recorded        18      ALL 2026-07-27/28, Threads era
posted_manually        0      the manual loop has never completed
migration head    0059_poll_counters.sql   (applied)
```

**Ingestion is not the bottleneck and has not been for some time.** The lane
finds news reliably; nothing downstream has published any of it.

---

## 1. The 26 press sources

One declarative family in `src/ingesters/regulatoryPress.ts`. Adding a source
is a `PRESS_SOURCES` row plus an attribution key plus a migration job row —
`jobs.ts` auto-registers the handler. No new code path.

| # | id | authority | filter |
|---|---|---|---|
| 1 | `press_sec_enforcement` | SEC | |
| 2 | `press_cftc_enforcement` | CFTC | **parked**, 403s Worker egress |
| 3 | `press_ftc_competition` | FTC | |
| 4 | `press_boj` | Bank of Japan | conference/research noise |
| 5 | `press_fca` | UK FCA | categories allowlist |
| 6 | `press_eu_commission` | European Commission | `Daily News` digests |
| 7 | `press_doj` | DOJ | grants, nominations, funding notices |
| 8 | `press_fed_speeches` | Federal Reserve | |
| 9 | `press_ecb` | European Central Bank | |
| 10 | `press_boc` | Bank of Canada | |
| 11 | `press_ons` | UK ONS | |
| 12 | `press_ofsi` | UK OFSI | |
| 13 | `press_rbi` | Reserve Bank of India | |
| 14 | `press_sebi` | SEBI | |
| 15 | `press_sec_speeches` | SEC Commissioners | |
| 16 | `press_cfpb` | CFPB | |
| 17 | `press_gao` | GAO | |
| 18 | `press_eba` | European Banking Authority | papers, vacancies, e-mail alerts |
| 19 | `press_boe_news` | Bank of England | |
| 20 | `press_riksbank` | Sveriges Riksbank | |
| 21 | `press_bea` | Bureau of Economic Analysis | |
| 22 | `press_eia` | US EIA | question-shaped explainers |
| 23 | `press_wto` | WTO | donations, explainers |
| 24 | `press_cma` | UK CMA | gov.uk document prefixes |
| 25 | `press_hmt` | HM Treasury | gov.uk document prefixes |
| 26 | `press_finma` | FINMA | German-language items |

Every authority is **unique**, enforced by a test — `PRESS_ATTRIBUTION`
resolves the citation from it, and a duplicate would make two sources share a
citation key. Two further tests: no two sources share a **URL**, and no two
share an **endpoint** (host+path, query discarded — added after the EU
Commission pair turned out to differ only by `&pagesize=20`).

### The four dialects

`parsePressFeed` reads all four. Batch 1 had **four of eight feeds parse to
zero** before this existed; batch 3 had twelve of twelve parse first try,
which is this work paying for itself rather than the later feeds being tidier.

| dialect | who | what breaks without it |
|---|---|---|
| **RSS 2.0** | 22 sources | — |
| **RSS 1.0 / RDF** | `press_boc` | date is `<dc:date>`, not `<pubDate>` |
| **Atom** | `press_cma`, `press_hmt`, `press_ofsi` | items are `<entry>`; the URL is an `href` attribute on `<link rel="alternate">`, not a text node; date is `<updated>`; body is `<summary>` |
| **CDATA anywhere** | fed-speeches, ofsi, rbi, wto | fields wrapped inconsistently *within one document* — early code unwrapped only `<title>` |

Two more shape rules that are not "dialects" but fail the same way:

- **Date fields** are read as the first of `pubDate` / `dc:date` / `published` / `updated`.
- **Body fields** as the first of `description` / `summary` / `content:encoded` / `content` / `dc:description`. `press_wto` uses `<content>`; the Atom three use `<summary>`. Reading only `<description>` silently dropped grounding text for nine items and **nothing failed** — the item still parsed, queued and posted, just thinner.

### Two parsing rules that are doctrine, not preference

**A date-only stamp anchors at UTC midnight and the source's offset is discarded.**
SEBI prints `31 Jul, 2026 +0530`. Honouring that offset anchored the item at
IST midnight → `2026-07-30T18:30Z`, and `publishedIso` is printed verbatim in
the draft, so the post stated **a calendar day before the one SEBI published
on**. A date-only stamp has no time; the offset applies to a moment the source
never gave. Nothing downstream catches this — the wrong date *is* the parsed
field, and the fabrication floor guarantees provenance, not correctness.

**Date-only sources get the 48h freshness allowance**, not 24h. Any midnight
anchor starts the clock before the source's working day. A SEBI order filed
23:45 IST was fresh for **15 minutes** under the old anchor and 5h45 under the
new one; both lose to an hourly poll.

### Rejection classes, in increasing difficulty of detection

86 candidates probed over three batches, 20 adopted. Four ways a source fails:

1. **Transport** — 404/403/503. A status check finds these.
2. **Shape** — 200, visibly contains items, parses to zero. Only running *our* parser finds these.
3. **Editorially empty** — parses perfectly, carries no market intelligence (CBO: 12 of 12 are cost estimates for minor bills; DOL: grant awards and single-restaurant back-wage recoveries). Only reading real titles finds these.
4. **Field-empty** — records look rich and the field you need is missing. **CPSC**: 0 of 40 July descriptions carry the unit count its own website prints, `Manufacturers` empty on 31 of 40. Only counting across a window finds these — the *first* CPSC record has a manufacturer.

**GDELT is a doctrine rejection, not a deferral.** It indexes other outlets'
coverage (`ria.ru` relaying the FT), which fails non-negotiable #2 outright.
An earlier record called it "usable, deferred", which invited someone to spend
a chunk building a parser for something that can never ship.

---

## 2. The FDA lanes

Three datasets, **one parser**, one grouper. openFDA serves identical field
names across all three, so a new dataset is a `FDA_SOURCES` row.

| lane | grades queued | why |
|---|---|---|
| `fda_drug_recall` | Class I + II | a CGMP or sterility failure names a listed manufacturer |
| `fda_food_recall` | Class I only | Class II ran ~33 events/month, mostly undeclared allergens at regional producers |
| `fda_device_recall` | **Class I only** | measured: Class I 151 rows → 38 events (~13/mo); Class II 640 rows → 200 events (~67/mo), **double the food rate that got food capped**, and Medline alone is 189 of those 640 |

**openFDA publishes one record per product**, so one recall arrives as many
near-identical rows — a 10-row device capture is 6 events. `groupRecalls` keys
on `event_id` + classification + reason, because classification varies within
an event ~9% of the time and grouping on `event_id` alone would print one
grade over products FDA graded differently.

### `fda_device_recall` is registered but is NOT a posting lane

`PRODUCT_RECALL` refuses a fact line for being **too long and too short**,
without stating either bound. Measured sweep against the real render path:

```
budget 300 -> 4/6 rendered    220 -> 5/6    180 -> 4/6
       260 -> 6/6             200 -> 4/6    160 -> 4/6
```

**Non-monotonic.** Two events failed at 301 weighted chars while others
rendered at 301 and 302 — the seed picks skeletons of different sizes. So
"truncate more" makes it worse below 260, and no constant is safe to tune
against a six-event fixture when the reviewer measured thirty-eight. Nothing
was shipped. **Owner of the window: the p4/ops session.**

### The drain bug worth knowing about

`pollFdaEnforcement` is the per-source fan-out and its drain query bound the
module constant `SOURCE` (`"fda_drug_recall"`), so **every lane drained the
drug lane**. `fda_food_recall` had never drained since it shipped on
2026-07-28 — items inserted `status='new'`, the food poll enqueued drug rows,
and the dedup key blocked a second chance. Nothing surfaced it: polls
succeeded, `source_state` stayed green, and Class I food runs ~17 events/month
so the silence looked like a quiet week. Fixed; the backlog drains three per
poll and a test pins that it is bounded and completes.

---

## 3. `total_failures` — semantics, and how to read it

`source_state.total_failures`, migration 0059, **applied**.

### Why it exists

`consecutive_failures` answers *"is it broken right now"* and **resets to 0 on
the next success**. `last_ok_at` is **overwritten** by every success. Between
them, a source failing two polls in three leaves **no trace at all** — a week
of one-in-three landing is byte-identical in D1 to a perfect week.

That cost a real answer: the Senate lag question below could not be resolved
retroactively because the evidence had already been overwritten.

### Exact semantics

- **Monotonic.** Only ever increases. It says nothing about now and everything about shape over time. Reading it as current health is the mistake it exists to prevent — hence the `total_` name.
- **Counts failed *polls*, on the `consecutive_failures` transition.** Not writes. `putSourceState` is called **several times per poll** by `bls.ts` (seven call sites) and `halts.ts` (five), so "+1 whenever this row is failing" would multiply by however many times the handler saved state. The ingester increments `consecutiveFailures` exactly once per failed poll, so a strict increase is the poll boundary.
- **There is deliberately no `total_polls`.** It cannot be collected here for the same reason. A failure count plus a known cadence gives the rate anyway: five failures in a week on a daily poll is five of seven.
- **Existing rows start at 0**, not back-filled from `consecutive_failures`. A back-fill would invent a history nobody recorded, which is the thing the column exists to fix.

### How to read it

```sql
SELECT source, consecutive_failures, total_failures, last_ok_at
  FROM source_state ORDER BY total_failures DESC;
```

Against a known cadence: `total_failures` growing by ~5/week on a daily job
means roughly five of seven polls failed. **All rows read 0 as of 2026-08-02**
because counting started at the migration — the numbers become meaningful
after about a week.

---

## 4. The Senate lane — intermittent, not blocked

**Status: enabled, polling, parsing. Producing no cards.** The cause is not
what three documents said it was for six days.

### What is observed

```
2026-08-02T13:30:01Z  Worker      200  full handshake, McCormick PTR parsed, filed 07/29
2026-08-02T05:36Z     residential 503  Senate's own maintenance page
2026-08-02T17:33Z     residential 503  Senate's own maintenance page
jobs.senate_ptr       enabled=1  daily_1330_utc  fails 0
```

The **Worker succeeded between two residential failures**, so availability
does not track client class. The 2026-07-27 record — *"403s Cloudflare Workers
egress … an IP/ASN-class block"* — does not hold, and p4-00's recommended
"owner-run residential courier" unlock was both unnecessary and, per
[the re-test](verification/2026-08-02-senate-efd-retest.md), would have failed
identically.

**The 403 was almost certainly real when measured. What was wrong was the
tense** — a timestamped observation written as a permanent property, and
nobody re-ran the one-line check for six days because everyone had a citation.

### How to read it forward, and the caution that matters

**This is one successful parse, not a trend.** One observation between two
failures establishes *"intermittent"*, not *"working"*. Do not upgrade it
without more samples.

All four `senate_ptr` items are `score=2` (postable) and all four are
`logged`. Today's was filed 07/29 and fetched 08/02 — `isFreshDateOnly` allows
48h, so it was stale on arrival and laked **correctly**.

So the flagship archetype's Senate half is dark because of **arrival latency,
not egress.** Two candidate causes, and they take different fixes:

| cause | fix | supported? |
|---|---|---|
| our once-daily poll misses windows when eFD is 503ing | **a retry inside the existing slot** | likely — three availability samples, two down |
| eFD itself indexes filings days late | revisit the freshness allowance | not tested |

**Read `total_failures` on `senate_ptr` in a week.** Growth means the polls are
missing and a retry is the fix. Flat means eFD indexes late and the freshness
allowance is the thing to revisit. That is exactly the question that was
unanswerable before 0059, and it now answers itself with no further work.

Ruled out: moving the hour. `13:30Z` is `09:30 ET`, inside US business hours,
and demonstrably a slot that sometimes works.

---

## 5. Open items, with evidence

### Blocking everything — the owner's, one tap each

| item | evidence |
|---|---|
| **The publish loop has never completed** | `post_log.posted_manually = 0`; `chosen_variant` NULL on all live cards. All 18 posts are 07-27/28, Threads era. |
| **#918 and #919 both have valid commentary waiting** | #918 dry/sharp/commentary all `valid` at 01:34; #919 commentary `valid` at 18:04. Both sitting untouched in Telegram. **Tapping Copy is now the ONLY unproven step in the whole pipeline.** |
| ~~**#919 fell back to a template**~~ **RESOLVED 18:04Z** | It regenerated after #120 deployed and produced **valid commentary**: *"Forex inflows total 40,816 by July 31, 2026, per the Reserve Bank of India / Nine prior Reserve Bank of India items…"*. The figure rejected six times is now licensed, and the "nine prior items" beat comes from our own lake. **#120 is exercised and it works.** |
| **BEA vs ONS** | blocks the press salience tier. A GDP advance estimate and a release-calendar entry are both "statistics" and only one is news. |
| **Commentary exemplars** | all seven run **296–354 weighted** against a 280 limit. The model has never been shown a commentary that can ship. |

### Correction to this document, 2026-08-02T18:0xZ

Two rows above were written before #919 regenerated and are struck through
rather than deleted, because the sequence is the point: the fix merged at
17:30Z, the failure it fixed was at 14:09Z, and I recorded it as *"deployed
and unexercised"* because at the time it was. It ran at 18:04Z and worked.

**What this changes:** generation is no longer an open question. The pipeline
now ingests, curates, grounds and writes end to end. **`copy_taps` and
`posted_manually` are both still 0**, so the only unproven step left is a
human pressing Copy.

**One detail worth keeping**, because it sharpens an item below. At attempt 2
the three variants split:

```
commentary  valid
dry         rejected:entity
sharp       rejected:number   <- "Published 2026-08-01T09:45:00.000Z."
```

The raw ISO timestamp is not merely ugly in copy-ready text — it is **failing
the fabrication gate and costing variants.** That moves it from a cosmetic
item to a functional one.

### Owned by the p4/ops session

- **`REGULATORY_NEWS` salience tier.** No `case` in `salienceFor`: flat base 70, floor 45, and `CEILING_EXEMPT` — so all 26 sources score identically and none can be capped. Owner's decision says *"enforcement actions"*; the code says the whole archetype. With the original six those nearly coincided. Evidence: [`2026-08-02-press-volume-vs-ceiling.md`](verification/2026-08-02-press-volume-vs-ceiling.md).
- **`PRODUCT_RECALL` window**, and reporting *which* bound was hit — a bound that is sometimes an under-bound is unreadable from a log.
- **`"Announced by X, per X"`** and raw ISO timestamps in copy-ready drafts. Both visible in #919's fallback text — and per the correction above, the ISO timestamp **fails `numberCheck` and cost the `sharp` variant** on #919's successful regeneration. Functional, not cosmetic.

### Owned by the ingestion lane — nothing is in flight

- **Senate arrival latency.** Measures itself forward via `total_failures`; see §4. Do not change cadence before reading it.
- **`press_cftc_enforcement`** parked at `consecutive_failures = 7`, 403 on Worker egress, deliberately left as an auto-recovering probe. Doctrine #4 forbids disguising the client.

### Known absence, not queued work

**Nothing in the codebase knows an institution has more than one name.** Three
subsystems have paid: the citation map (`per ECB` vs `per European Central
Bank`), the RBI grounding anchor (payload says "Reserve Bank of India", body
says "RBI" — killed 7 of 12 generations), and the `per ECB` validator
rejection.

Deliberately **not** built. A synonym table is a licence to substitute one
string for another **inside a gate whose entire job is refusing
substitutions**. If it ships it needs the #80 bar: token-boundary matching, a
regression suite built from real poison, and a note on every validator that
consumes it. Recorded so the fourth instance is recognised rather than patched
locally again.

### Looked past by all three sessions

**Card #321 has sat unanswered for five days.** Queue TTLs expire unactioned
cards while their items stay `queued`. With a publish loop that has never run,
every card is on that path, and **nobody has measured what happens to the item
when its card expires.**

---

## 6. Standing discipline this lane learned the hard way

- **Verify the operand, not just the operation.** A reviewer confirmed an arithmetic and never asked what it was computed over; a mutation run confirmed an exit code and never asked what it was applied to; I confirmed a count and never asked what it was counted over (CPSC: 55 was "July onward", not July).
- **A mutation test is a reporter.** Its success is evidence about the *mutation*, not the guard. Two of mine were no-ops that reported a guard missing when the guard was fine — **read the diff, not the exit code.**
- **Absence and failure must not share a face.** A D1 helper written that same night printed `(0 rows)` for both "matched nothing" and "did not run".
- **A local suite result is not evidence about CI**, and a passing PR check is not evidence about the tree it will become — every green tonight was measured against a base that had already moved.
- **Never pass `--delete-branch` to a PR that is another PR's base.** GitHub closes the child silently and irreversibly; it cost two PRs. And a stacked child cannot simply be rebased after its parent squash-merges — cherry-pick its own commit instead.
