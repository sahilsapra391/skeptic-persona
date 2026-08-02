# Handoff: salience, tiering, budget, recall window, pacing

**Written 2026-08-02** as the RAG/generation session parks. Everything below is
**another session's lane** — I read the shipped code and their verification
records to write this, and I have **not** re-run their measurements. Every
number is attributed to the record it came from so the next reader knows which
claims are load-bearing and which are inherited.

The one thing I did verify directly, because it changes what "open" means:
`digest_push` and `voice_digest` are both `enabled=1` in production, and no
salience knob is set in `[vars]` — **defaults are in force**.

---

## 1. Salience implementation

**Shipped.** `src/salience.ts` (pure — no I/O, no clock, so the replay and the
live gate cannot disagree) + the gate in `src/pipeline/enqueue.ts`.

Score = ordinal category base + magnitude features. Held items go
`status='digested'` into `digest_items` and are recovered by a 21:00 ET
roll-up with a ↑ promote control.

**The design rule that matters, and it should not be relaxed casually.** Bases
encode **ordering only**. The engagement study forbids its own ratios as
coefficients — *"ratios transfer directionally, not numerically"* — so
congress > enforcement > insider > macro > rates appears as ordinal tiers and
the 1.67x / 1.13x / 0.56x figures appear nowhere in the file. Categories the
study could not measure (halt, recall; n<25) sit mid-tier and are discriminated
by magnitude rather than punished by base: **absence of evidence is not
evidence of low value.**

**Acceptance was a replay against real production data**, not a claim:
`scripts/replay-salience.mjs` scores every card production actually created.
Result: 153/day → 30.3/day, an 80.2% reduction, with false negatives stated.

### Open defects and live hazards

- **`SALIENCE_FLOOR` is a silent kill switch if mis-set.** The code clamps to
  0–100 and warns, but a value inside that range still holds every item in
  every category. Not a bug; a knob whose failure mode is silence.
- **Reg SHO cannot be digested as planned.** `diff.exited` is never persisted
  (`regsho.ts` inserts only `entered`), so the "nightly joins/leaves" card the
  plan asks for **cannot be built from stored data** without an ingester
  change. Recorded, not attempted.
- **Data-integrity landmine for any approval metric.** 18 `post_log` rows have
  `queue.state='expired'`, which no shipped code path can produce — an
  out-of-band UPDATE reset them. **Reading `queue.state` alone undercounts
  approvals by 18** and makes six archetypes look uniformly 0%. Every number in
  the salience record uses `state ∪ post_log`. Anyone recomputing must do the
  same or they will "discover" a regression that is not there.

---

## 2. The tier map — proposed, deliberately NOT built

There is **no tier module in the repo.** `src/ingesters/` has none, and this is
by design, not omission.

### The gap it closes

The owner's plan of record, verbatim:

> **Congress PTRs and enforcement actions are EXEMPT from the daily ceiling.**

**The decision says "enforcement actions". The code says `REGULATORY_NEWS`.**
With the original six press sources those phrasings picked out nearly the same
set, so the gap cost nothing. Press then went 6 → 26. The exemption now also
covers SEBI recovery certificates, ONS release-calendar entries, GAO reports,
BEA statistical releases and FINMA ordinance notices.

**The wording did not change; the population under it did.**

Measured consequence: `salienceFor` has **no `case "REGULATORY_NEWS"`**, so
every press item scores the flat base of **70** against a floor of 45, and
`REGULATORY_NEWS` sits in `CEILING_EXEMPT`. Every press item from all 26
sources pushes, uncapped, indistinguishable from every other. Defensible range
**50–90 press items/day**, against a 25/day soft target for *everything*.

### The proposed mechanism

A tier declared **per authority**, in a leaf module keyed the way
`PRESS_ATTRIBUTION` is, read by a new `case "REGULATORY_NEWS"` in
`salienceFor`, with `exempt` computed from the tier rather than the archetype.

**Keying on authority works, and it is worth stating because it looks like it
should not.** The obvious objection is that `press_sec_enforcement` and
`press_sec_speeches` are the same institution. In production they are not the
same key:

```
press_sec_enforcement   authority = "SEC"                 28 items
press_sec_speeches      authority = "SEC Commissioners"   25 items
```

Authority is unique per source by a **test-enforced invariant**
(`test/globalWire.test.ts`), `payload.authority` is already on every press
payload, so `salienceFor(archetype, payload)` needs no signature change, and
the leaf map is guarded against divergence by the parity test from #110.

`regulatoryPress.ts` already groups these in prose — one block `// ---
Enforcement wire.`, another `// --- GLOBAL WIRE FANOUT`. **The grouping exists;
it is a comment, so salience cannot read it.** Promoting the file's own stated
grouping into a field beats inventing a taxonomy.

---

## 3. The BEA vs ONS decision — what it blocks, explicitly

**This is the item to act on first, because it is the only one where the code
is designed, the mechanism is validated, and a single editorial answer unblocks
it.**

The tier map is **measured by the ingestion session and is the p4 session's to
build**. It is not blocked on engineering. It is blocked on two owner calls the
implementing session correctly refused to make for him:

**(a) The weights are editorial, not technical.** Choosing how far below the
floor an ONS release-calendar entry should sit is an editorial call. The
implementing session's stated reason for not picking a number:

> the one number I could invent to justify it — "statistics are worth -30" —
> would be exactly the kind of constant this project has spent two days proving
> nobody should tune against a fixture.

That is the salience layer's own rule applied to itself: bases encode measured
ordering, never a guessed coefficient.

**(b) BEA is not ONS, and a tier per authority may be too coarse.** A GDP
advance estimate and a release-calendar entry are both "statistics" and are not
both routine. **This is the decision.** Concretely, the owner must answer:

> Does a BEA statistical release belong in the same tier as an ONS
> release-calendar entry — or does routine-vs-substantive cut *within* an
> authority, meaning the key must be finer than `authority`?

**What each answer unblocks:**

- **"Same tier"** → tier-per-authority is sufficient. The leaf map can be
  written immediately against the existing `payload.authority` key, no
  signature change, no ingester change. Build it.
- **"Different tiers"** → `authority` is the wrong key and the design needs
  revisiting before code. The likely shape is a per-source tier rather than a
  per-authority one, which changes where the map lives and what the parity test
  asserts.

Until one of those is chosen, **the exemption stays live and uncapped**, and
every full poll cycle spends it. That is the current state, not a hypothetical.

**One cheap input that was owed and may now exist:** the publication rates
above came from backfill windows, some only two days wide. *"The first full day
of data settles the range"* — one steady-state day across all 26 sources gives
the real number. If a full day has now elapsed, re-measure before choosing
weights.

---

## 4. The `over_budget` split

**Nothing shipped, and the reason is the finding.**

`renderPost` returns `{ ok: false, reason: "over_budget" }` when no skeleton
fits the post budget. `enqueueForApproval` turns that into `status='logged'` —
which the drain (`status='new'`) never sees again, and the dedup key stops
re-ingest. **Dropped permanently and silently.**

Measured: **24 of 38 live Class I device events** failed this way. Reproduced
on the shipped 10-row fixture through the real render path:

```
drug     6/6 rendered   {}
device   4/6 rendered   {"over_budget": 2}
```

Direction confirmed — device `reason_for_recall` is simply longer: median 187
vs drug's 124 on the fixture, 268 vs 76 over the reviewer's live window.

**The split that is wanted:** distinguish "this item is genuinely unpostable"
from "this renderer could not fit it", so the second does not silently become
the first. Today both land on `logged` and neither is recoverable.

---

## 5. The PRODUCT_RECALL length window

**The most important finding in this handoff, because it invalidates the
obvious fix.**

`draftRecall` caps `product` at 90 chars and leaves `reason` unbounded, so
completing that pattern looks like the fix. **It is not.** Capping the reason
at 160, 130 and 110 moved device from 4/6 → 4/6 → 5/6.

Sweeping the fact-line budget against the real render path:

| budget | drug | device |
| --- | --- | --- |
| 300 | 6/6 | 4/6 |
| **260** | 6/6 | **6/6** |
| 220 | 6/6 | 5/6 |
| 200 | 6/6 | 4/6 |
| 180 | 6/6 | 4/6 |
| 160 | 6/6 | 4/6 |

**Non-monotonic. Shorter is worse below 260**, so there is a **floor as well as
a ceiling** — a fact line must land inside a window the archetype never states.
Two events failed at 301 weighted while others rendered at 301 and 302, because
the seed picks different skeletons and they are not the same size.

**A composer that targets a cap can push a line under the floor and make things
worse**, which the 200 and 180 rows show happening.

Nothing shipped: 260 renders all six on a **six-event fixture** while the
reviewer measured **thirty-eight** live. Tuning a constant to six events is
fitting noise, and the budget-aware composer was reverted with it — trimming
toward an unknown floor is not obviously safe for the drug and food lanes,
which work today.

**The real work is writing the window down.** An archetype that refuses a fact
line for being too long *and* for being too short, without stating either
bound, cannot be targeted by the code that builds the line. That contract
belongs to `PRODUCT_RECALL`, not to an ingester.

> **The device lane is registered and laking events. It is NOT a working
> posting lane and should not be treated as one.** The 33% figure is the
> fixture's, not production's.

---

## 6. Dispatcher and pacing

**Shipped.** `src/dispatch.ts` runs the tick concurrently.

```
TICK_JOB_CONCURRENCY      = 3   (default)
MAX_TICK_JOB_CONCURRENCY  = 3   (ceiling for the [vars] override)
```

**`resolveConcurrency` is a FALLBACK, not a clamp, and the difference is
operational.** An operator raising `TICK_JOB_CONCURRENCY` to 8 during a backlog
gets **3 — the default**, which is lower than the 6 they might expect from
clamping and lower than they asked for. So the lever appears to do nothing, or
the wrong thing, in exactly the incident where somebody is reaching for it. It
logs a warning naming the configured value; that warning is the only thing
standing between an operator and a silent no-op.

**Two pacing knobs that look like one concern and are not:**

- `TICK_JOB_CONCURRENCY` — how many *jobs* run per tick.
- `QUEUE_NOTIFY_SPACING_MS` — paces *Telegram messages* (≤ 1/s per chat).

`dispatch.ts` documents the distinction in-line. Conflating them is the
foreseeable mistake.

### Status of the one defect raised against it

The `resolveConcurrency` override plumbing was flagged as unguarded after the
concurrency fix. **It now has direct tests** — `test/dispatch.test.ts`,
`describe("resolveConcurrency is a fallback, not a clamp (p4-23 follow-up)")`.
Verified present. Treat as closed unless the implementing session says
otherwise.

---

## 7. One defect in the generation lane, added after parking

Recorded here rather than lost, because it was found by the ingestion session
after both handoffs were written, and it is in `validate.ts` — my lane.

**A raw ISO timestamp in a draft fails `numberCheck` and costs a variant.**
Live: `#919`'s `sharp` variant died on `"Published 2026-08-01T09:45:00.000Z."`

Reproduced against the real payload — and the rejection is on the string's
COMPONENTS, which is the part that names the cause:

```
"08"  does not appear in the payload
"01"  does not appear in the payload
"09"  does not appear in the payload
"000" does not appear in the payload
```

The same sentence written as `"Published August 1."` passes.

**The defect is an asymmetry between the two sides of the same check.**
`payloadFacts` consumes ISO strings structurally, so the payload side never
leaks `2026-08-01` as the free integers 2026, 8, 1 — that was bypass #4, closed
twice. `draftNumbers` does **not** do the same on the draft side, so a model
that quotes a timestamp verbatim has it shredded into unlicensed components.

It is bypass #4 inverted: that one leaked payload components **in** as
licensed, this one leaks draft components **out** as unlicensed. Both come from
one side of a pair treating ISO strings structurally and the other not.

**Not cosmetic — it costs a whole variant**, and the fix is not a prompt
instruction telling the model to avoid timestamps. It is making the draft side
consume ISO datetimes the way the payload side already does, then checking the
resulting date against the payload's dates as a tuple. The bypass-#4 machinery
to do that already exists and is tested; it is simply not applied to the draft
side of this path.

**Care required**, and it is why this is a note and not a patch: the draft side
is where `numberCheck` catches fabricated quantities, so anything that consumes
digits there widens what a draft may state. Any fix needs the enumerate-the-
class treatment the owner's #80 bar sets for a fabrication-gate relaxation, not
a one-line regex.

### The payload side is fixed by doctrine — do not "fix" it upstream

The obvious upstream move is to stop writing full ISO into `publishedIso`.
**That is not available.** CLAUDE.md mandates *"All times stored as ISO-8601
UTC. Feed timestamps arrive in four different conventions — normalize at
parse."* Four dialects arrive in four conventions and ISO is what makes them
comparable. Changing the stored format to dodge a tokenizer trades a real
invariant for a symptom.

So the pair can only be made symmetric **on the draft side**, which is where
this is flagged.

### It is OUR beat, not the model quoting a timestamp

`archetypes.ts:889-894`:

```ts
{ id: "reg.dateStamped",
  text: "Published {publishedIso}.",
  tier: "base",
  when: { op: "has", field: "publishedIso" } }
```

`fillSlots` substitutes `String(raw)` with no formatting, and `eligibleBeats`
hands the gated beat to the prompt under *"you may use AT MOST one, verbatim or
not at all"*.

**So the pipeline offers the model a beat that cannot pass its own validator.**
The model is not quoting a timestamp of its own accord; we are giving it one
and then rejecting it.

**And it can NEVER pass, for any press item, ever.** `publishedIso` is always a
full ISO string — `regulatoryPress.ts` returns `d.toISOString()` on both paths
(lines 341 and 344), so there is no shape in which that beat renders anything
`numberCheck` can accept. `reg.dateStamped` has been offered to the model and
rejected on **every REGULATORY_NEWS generation since it shipped**.

That settles the fix. The tokenizer change widens what a draft may state and
needs the #80 bar; **the beat change removes a slot that was never usable.**
Cheaper, narrower, and it closes both exits at once — `"Published August 1."`
passes and reads like something a person wrote, which the ISO never did.

Worth noting how close this came to being seen already: `regulatoryPress.ts:332`
carries the comment *"publishedIso is printed verbatim by the REGULATORY_NEWS
date beat"* — written about a timezone-anchoring concern. The verbatim printing
was known; its validator consequence was not, because the two live in different
files and nobody asked the second question.

**And there are two independent exits**, so fixing only the tokenizer leaves
one live: the validator rejecting a true statement, *and* a copy-ready draft
containing `2026-08-01T09:45:00.000Z` on the occasions it passes. Nobody wants
that in a post.

---

## A note on how these handoffs were split

Two handoff documents were written, split **by subsystem**. Both this defect
and the `#321` card-lifecycle question fell in the gaps *between* subsystems
and had no owner in either doc — this one because it is generation rather than
salience, that one because it spans queue lifecycle and the publish loop.

Each was caught only because the two sessions kept talking after parking.
**The next pair will split the same way**, so it is worth knowing that the
gaps between the lanes are where the unowned items live.

## Provenance

Sections 1–6 describe code and measurements produced by the ingestion and p4
sessions. I read `src/salience.ts`, `src/pipeline/enqueue.ts`,
`src/dispatch.ts`, `src/templates/render.ts`, `test/dispatch.test.ts`, and the
records below, and verified only the four live facts stated at the top.

Source records, all on main:

- `docs/verification/2026-08-01-p4-03-salience.md`
- `docs/verification/2026-08-02-press-volume-vs-ceiling.md`
- `docs/verification/2026-08-01-recall-sources.md`

**Numbers I did not re-run should be re-verified before anything is tuned
against them** — several were measured against fixtures or short backfill
windows, and each record says which.
