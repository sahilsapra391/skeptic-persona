# p5-03 verification: the REGULATORY_NEWS tier

**Verified:** 2026-08-05 UTC against the live `skeptic-wire` D1 database
(`d951177f-e4ab-4b6b-a014-efc7d78d065e`).

## What the chunk was asked to do

> p5-03 REGULATORY_NEWS salience tier per the BEA/ONS ruling (data prints card
> at MACRO tier; release-calendar entries are ledger/digest only). Drain the
> 133 pending cards through it.

The first sentence is built and verified. **The second is not achievable from
the ruling in the first**, and the numbers below are why. Reported rather than
worked around.

## 1. The premise holds: REGULATORY_NEWS is the flood

```
SELECT archetype, COUNT(*) FROM queue WHERE state='pending' GROUP BY archetype;
-> REGULATORY_NEWS 80, FILING_FORM4 26, INSIDER_NOTICE 13, OWNERSHIP_STAKE 4,
   PRODUCT_RECALL 3, INSIDER_CLUSTER 3, FILING_8K 2, SETTLEMENT_FAILURE 1,
   POLICY_ACTION 1, DELISTING 1        (134 pending)
```

REGULATORY_NEWS is **80 of 134**, 60%. Every one of those scores a flat 70
against a floor of 45 and is ceiling-exempt, exactly as the salience handoff
measured.

Card ages: 62 at ~12h, 6 at ~24h, 41 at ~36h, 25 at ~46h. All inside
`QUEUE_TTL_HOURS=48`, so nothing is stuck. "Draining" cannot mean unsticking a
backlog; it can only mean not carding them in the first place — and see the
correction in section 3, which establishes that it cannot mean re-scoring the
existing ones either.

## 2. The ruling is implemented, and keyed correctly

`payload.authority` is 1:1 with a press source, pinned by
`test/globalWire.test.ts`: *"gives each source its own authority, so no two
sources share a citation key"*. So an authority-keyed map resolves per source
and needs no signature or ingester change.

Both tiered sources are **objective, not editorial**:

- `press_ons` -> `RELEASE_CALENDAR`. Its endpoint is literally
  `https://www.ons.gov.uk/releasecalendar?rss`. The source declares what it is.
- `press_bea` -> `DATA_PRINT`. Live payloads are the releases themselves:
  `"U.S. International Trade in Goods and Services, June 2026"`,
  `"Gross Domestic Product by Metropolitan Area, 2016"`.

Behaviour, test-pinned: a data print scores exactly `CATEGORY_BASE.MACRO_PRINT`
(55, still above the floor, still cards); a release-calendar entry scores 0 and
can never card. Both **lose the ceiling exemption**, because the owner's
amendment exempted *"enforcement actions"* and establishing that a source is a
statistics feed is establishing that it is not one.

## 3. The measured effect on the queue: ONE card

Pending REGULATORY_NEWS by authority, live:

```
 25  DOJ                                    3  UK CMA
 14  Bank of Japan                          3  GAO
 11  SEBI                                   2  UK FCA
  8  Reserve Bank of India                  1  WTO / EIA / SEC Commissioners
  4  SEC                                    1  CFTC / Bank of England
  4  European Commission                    1  Bureau of Economic Analysis  -> DATA_PRINT

TOTAL 80    affected by the tier: 1    untiered (unchanged): 79
```

**One card of eighty comes from a source this tier now covers.**

### CORRECTION (same day, before any status was reported as done)

An earlier draft of this section said that BEA card "moves 70 -> 55 and loses
its exemption". **That was wrong, and the error mattered.** `salienceFor` is
called from exactly one place, `pipeline/enqueue.ts`, at enqueue time, where it
decides push-versus-digest once. Nothing re-scores a queue row afterwards.

So the tier changes **zero** of the 134 pending cards. The 1 above is not a
card that moves; it is one card whose source is now covered, meaning an
equivalent item arriving from BEA tomorrow would score 55 instead of 70.

This makes the chunk's second acceptance clause structurally, not just
numerically, unreachable: **"drain the 133 pending cards through it" would need
a re-scoring pass over existing queue rows, and no such mechanism exists.**
Salience is a one-shot admission gate by design. Building a retroactive
re-score is a different chunk with its own risks (it would move cards the owner
has already seen), and it is not in this one.

The two ruled sources barely reach the queue at all:

```
SELECT source, COUNT(*), SUM(status='logged') FROM items
WHERE source IN ('press_ons','press_bea') GROUP BY source;
-> press_bea  48 items, 47 logged
-> press_ons  10 items, 10 logged
```

**ONS has never produced a card.** All 10 items were suppressed upstream by the
existing freshness and newsworthy gates. The `RELEASE_CALENDAR` tier is correct
and it is currently latent: it is a guarantee about the future, not a change to
today.

(Related, and NOT a defect: 25 of BEA's 48 items predate 2025, oldest
2013-04-18, because the BEA RSS feed serves a decade of history. The freshness
gate marks them `logged` so they never card. The lake keeps them by design.)

## 4. Where the flood actually is, and why this chunk does not touch it

DOJ 25, Bank of Japan 14, SEBI 11, Reserve Bank of India 8 = **58 of 80**.
None is a data print or a release calendar, so the BEA/ONS ruling says nothing
about any of them.

Tiering them is the editorial call the p4 session explicitly refused to make
for the owner, on the grounds that the salience layer forbids exactly this:

> the one number I could invent to justify it -- "statistics are worth -30" --
> would be exactly the kind of constant this project has spent two days proving
> nobody should tune against a fixture.

That reasoning is unchanged, so the other 24 sources keep today's behaviour
byte for byte, and a test pins that they do.

### The handoff's proposed shortcut does not work

The salience handoff suggested a way to avoid an owner decision:

> `regulatoryPress.ts` already groups these in prose [...] Promoting the file's
> own stated grouping into a field beats inventing a taxonomy.

**Checked, and it does not survive contact.** The file has two prose groups,
and the second one is provenance, not semantics:

> `// --- GLOBAL WIRE FANOUT, batch 1 (p4-11). Every URL below was live-probed
> 2026-08-01T22:4xZ [...] Eleven other candidates failed`

That records *when a URL was probed*, not what the source is. `press_doj` sits
inside that batch while `press_boj` sits under `// --- Enforcement wire.`, so
promoting the grouping would rank **DOJ enforcement below Bank of Japan press
releases**. The grouping is chronological. It cannot be a tier.

## 5. What the owner is being asked for

One message unblocks the rest. The four sources that are 58 of the 80 pending
cards, each with its lifetime card count, so the call is cheap:

| Authority | Pending | What it publishes |
|---|---|---|
| DOJ | 25 | Press releases across all divisions, not only enforcement |
| Bank of Japan | 14 | Central-bank releases and notices |
| SEBI | 11 | Orders, circulars, recovery certificates |
| Reserve Bank of India | 8 | Notifications and press releases |

The question is the same shape the BEA/ONS ruling answered: **which of these
are substantive events that should card, and which are routine publication
that belongs in the digest?** Any source the owner rules on gets a key in
`REGULATORY_NEWS_TIER` and inherits the mechanism already built and tested
here. No further engineering is required to act on the answer.

## 6. Tests

Six added, all against the real `PRESS_SOURCES` registry rather than fixtures:

- **parity**: every key in `REGULATORY_NEWS_TIER` is a real press authority.
  This is the one that matters most, because the map is keyed on a string and
  an absent key is a deliberate no-op, so a *typo* would be indistinguishable
  from a source we chose not to tier. It would look right in review and do
  nothing in production.
- a BEA data print scores exactly the MACRO tier and still clears the floor
- an ONS release-calendar entry scores 0 and is below the floor
- tiered sources lose the ceiling exemption; DOJ (untiered) keeps it
- **all 24 untiered sources are unchanged**: base 70, exempt, above the floor.
  This is the scope-creep guard. If a later edit tiers a source the owner has
  not ruled on, this fails and names the source.
- an unknown or non-string authority is untouched, never accidentally demoted

Suite: 1,024 passing, 1 pre-existing failure (D-6, red on main).
