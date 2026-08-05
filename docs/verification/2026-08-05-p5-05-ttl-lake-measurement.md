# p5-05: what happens to a lake item when its card expires

**Measured:** 2026-08-05 UTC against the live `skeptic-wire` D1 database
(`d951177f-e4ab-4b6b-a014-efc7d78d065e`). Read-only; this chunk changes no
behaviour. It answers the question the plan asked and puts numbers under the
re-card decision, which is the owner's.

## The short answer

Expiry costs the QUEUE ENTRY, not the lake item. The item stays, stays
readable, and stays groundable. What it loses is any route back to a card.

## 1. Mechanically, expiry does exactly two things

`expirePendingBefore` (`lib/db.ts`) writes:

```sql
UPDATE queue SET state = 'expired', decided_at = ?1 ...
UPDATE items SET status = 'expired'
  WHERE status = 'queued' AND id IN (SELECT item_id FROM queue WHERE state = 'expired')
```

Nothing is deleted. The payload, `raw_text`, `source_url` and every parsed
field survive intact.

## 2. The lake is NOT blinded, and this is the reassuring half

`rag/context.ts` builds lake context with two queries (lines 93 and 123), and
**neither filters on `items.status`**. They key on `source`, `id <> ?`, and an
entity clause:

```sql
SELECT COUNT(*) AS n, MIN(...) AS window_start, MIN(fetched_at) AS coverage_from
FROM items WHERE source = ?1 AND id <> ?2 <entityClause>
```

So an expired item still counts toward "we have covered this source N times
since X" and can still surface as a recent-item line in a prompt. Expiry does
not shrink the grounding corpus.

That is now pinned by a test rather than left to inspection, because a future
`AND status = 'queued'` added for a good-looking reason would silently drop
832 items out of the lake with no failure anywhere.

## 3. The real cost: 'expired' is MORE terminal than 'digested'

Nothing in `src/` reads `status = 'expired'`. There is no re-card path, no
promotion, no sweep.

Compare `digested`, from migration 0044's own reasoning:

> 'digested' is distinct from 'logged' on purpose: logged never met the bar,
> digested met it and lost the slot. Only digested rows promote.

A digested item has a route back: the digest's `↑` button calls
`promoteHeldItem` and it becomes a full card. An expired item has none.

**So an item that reached a card and was not looked at is harder to recover
than one that never made the bar.** That inversion is the actual finding of
this chunk, and it is the thing the re-card policy has to answer.

## 4. The numbers

```
SELECT status, COUNT(*) FROM items GROUP BY status;
-> logged 15,523 | expired 832 | digested 321 | queued 138 | new 75
   posted 18 | approved 12 | rejected 1
```

919 queue rows are `expired` (832 items carry the status; the gap is rows whose
item was later re-used or never flipped from a non-`queued` status).

Composition, which is what decides the policy:

```
SELECT archetype, COUNT(*) FROM queue WHERE state='expired' GROUP BY archetype;
-> FILING_8K 235 | HALT 220 | INSIDER_NOTICE 157 | FILING_FORM4 97
   OWNERSHIP_STAKE 85 | REGULATORY_NEWS 37 | POLICY_ACTION 19 | DELISTING 18
   PRODUCT_RECALL 17 | SETTLEMENT_FAILURE 12 | POSITIONING 8 | INSIDER_CLUSTER 8
```

| Group | Count | Share |
|---|---|---|
| The four flood classes (FILING_8K, HALT, OWNERSHIP_STAKE, INSIDER_NOTICE) | 697 | **76%** |
| Owner-exempt categories (CONGRESS_PTR, REGULATORY_NEWS, POLICY_ACTION) | 56 | 6% |
| Everything else | 166 | 18% |

Three-quarters of everything that ever expired is from the exact sub-classes
p4-03 salience later demoted below the floor: 8-K item 5.02, volatility halts,
13D/G amendments and small Form 144 notices. **A blanket re-card would spend
its first 697 cards re-showing the flood the curation layer was built to
suppress.**

CONGRESS_PTR, the flagship, has **zero** expired cards.

## 5. A number that looks alarming and is not

Average card lifetime before expiry, by day:

```
2026-08-04   n=2     min 48.0   avg 48.0   max 48.0
2026-08-03   n=5     min 12.2   avg 33.8   max 48.2
2026-08-01   n=90    min  6.0   avg  6.5   max  7.1
2026-07-31   n=151   min  6.0   avg  6.3   max  6.8
2026-07-30   n=180   min  6.0   avg  6.6   max  7.4
```

Aggregated over all time this reads as "cards expire in ~6 hours", which
against `QUEUE_TTL_HOURS=48` looks like a live defect. It is not. The ~6h rows
are historical: they expired under the OLD TTL, before the owner's 2026-08-01
change. Every expiry from 2026-08-03 on lands between 12h and 48h, which is
the new value plus the committed overrides
(`MACRO_PRINT:12, HALT:12, CONGRESS_PTR:96`).

The TTL change works. Recorded here because the aggregate is the number a
future session is most likely to read first and misdiagnose.

## 6. Re-card policy: the options, and a recommendation

**This is an owner decision. It is not one of the plan's five, but it is
editorial, so it is not mine to settle.**

- **(a) Do nothing.** Expiry stays terminal. Cheapest, and correct for 76% of
  the population.
- **(b) Blanket re-card on expiry.** Re-queue anything that expired unseen.
  Rejected on the numbers above: it re-shows the flood, and it fights the
  curation layer rather than using it.
- **(c) Give expired items the promote path digested items already have.**
  Recommended. It costs one query change rather than a new mechanism, it is
  pull-not-push so nothing re-floods the queue, and it closes the inversion in
  section 3 directly: the owner could pull back a specific card he missed,
  exactly as he can already pull back one that never made the bar. The 56
  exempt-category expiries are the population it would serve.

No code ships in this chunk beyond the guard test, because (c) is a behaviour
change and the plan asked for a measurement first.
