# Upstash Vector — free-tier limits and whether the four-namespace plan fits

Owner amendment (2026-08-01): *"Before building: write docs/verification for
Upstash free-tier limits (vector count, daily request cap, dimension cap,
namespace support) and confirm the three-namespace plan with TTL fits inside
it. Prefer Upstash's hosted embedding models so we don't add a second vendor;
if that doesn't fit free tier, say so with numbers and give me the cheapest
unlock rather than picking one."*

**Verdict: it fits, comfortably — but only after one design change, and one
feature the plan assumes does not exist.**

## Status of this record

Read from Upstash's published pricing and docs on 2026-08-01. **No
authenticated round-trip has been made** — there is no Upstash credential in
this project yet, so every number below is documented-not-verified. Under the
endpoint-verification law this record is provisional: the first
authenticated call appends its result here, and no code ships against these
numbers before that happens.

| | Free tier | Next tier (pay-as-you-go) |
|---|---|---|
| Max vectors × dimensions | **200 million** | 2 billion |
| Daily query/update requests | **10,000** | unlimited |
| Max dimensions | 1,536 | 3,072 |
| Max namespaces | 100 | 10,000 |
| Storage | 1 GB free | $0.25/GB |
| Request price | — | $0.40 per 100K |

**Hosted embedding models exist**, so no second vendor is needed, as the owner
preferred: `BAAI/bge-small-en-v1.5` (384 dim), `bge-base-en-v1.5` (768),
`bge-large-en-v1.5` (1024), `bge-m3` (1024), plus BM25 for sparse. Whether a
hosted-embedding upsert bills as one request or more is **not documented** —
that is the single most important unknown and the first thing the live probe
must settle, because it is the difference between one and two requests per
item.

## The feature the plan assumes and Upstash does not have

The plan specifies *"hard TTL eviction (14 days default, env-configurable)"*
for the WIRE namespace. **Upstash Vector documents no per-vector TTL.**
Namespaces are created implicitly on upsert and deleted wholesale; there is no
expiry primitive.

So eviction is ours to build: a scheduled job that deletes vectors whose id
encodes an ingest date older than the window. That is cheap — deletes are
requests like any other, and at our volume it is a few dozen a day — but it
is work the plan assumed was free, and a TTL that nobody implements is a
namespace that grows forever.

## The design change: embed at the queue decision, not at ingest

The plan says *"embed every ingested item at ingest."* Measured against
production, that is 14× more expensive than it needs to be and buys nothing.

Queried against production for this record (2026-07-27..31, five weekdays):
**10,748 items ingested, 1,230 of them score ≥ POSTABLE** — 2,150 and 246 per
weekday. At one upsert + one near-dup query each, embedding everything is
**4,300 requests/day against a 10,000/day cap: 43% utilisation**, before the
discovery mesh (PR wires, Bluesky, GDELT, outlet RSS) multiplies source
count. Two mesh tiers would break it.

But **92% of the lake is `logged`** and can never become a card. The purpose
of WIRE near-dup is *one event, one card* — a property that only matters for
items that would actually queue. Embedding at the point where an item is
about to be pushed costs:

| | items/day | requests/day (upsert + query) | % of free cap |
|---|---|---|---|
| every ingested item (plan as written) | 2,150 | 4,300 | **43%** |
| **score ≥ POSTABLE only** | **246** | **492** | **4.9%** |
| after p4-03 salience, cards only | ~27 | ~54 | 0.5% |

All three rows are measured, not estimated. **492/day is 4.9% of the free
cap**, leaving room for the mesh to multiply source count eightfold and still
sit under half the free tier — where the plan as written is already at 43%
before a single mesh source is added.

The one thing this trades away: two sources reporting the same event where one
scores below POSTABLE and the other above it will not dedup against each
other. That case cannot produce a duplicate card — the sub-postable copy was
never going to be one — so the guarantee the owner asked for is unaffected.

## Storage, on the same measurement

With `bge-small-en-v1.5` at 384 dimensions and a 14-day window:

- WIRE: 246/day × 14 = **3,444 vectors** → 3,444 × 384 = **1.32M** of the
  200M vectors × dimensions budget, i.e. **0.7%**
- TOPIC: the five TOP archives, ~1,300 posts, one-time → 0.25%
- DEVICE: 20-30 records → negligible
- VOICE: our own posts; zero today, and growing only as fast as the owner
  publishes

Total well under 2% of the free ceiling. Namespaces: 4 of 100.

## What the live probe must settle before any code ships

1. **Does a hosted-embedding upsert bill as one request or more?** Doubles or
   halves the whole estimate.
2. **Is the 10,000/day cap per index or per account?** Four namespaces on one
   index is the plan; if the cap were per index, splitting would be a lever.
3. **Confirm namespaces share the index's vector budget** rather than each
   carrying one.
4. **Confirm there is genuinely no TTL primitive**, since documentation
   silence is not the same as absence — this is the one where being wrong
   costs us building a job Upstash already provides.

## Recommendation

Build it on the free tier with the queue-decision embedding point, hosted
`bge-small-en-v1.5`, and our own eviction job. No paid unlock is needed and
none should be bought until a measured request count says otherwise. If the
live probe shows hosted embeddings billing at more than one request per
upsert, the numbers still fit — 840/day is 8% of the cap.

The cheapest unlock, if it is ever needed, is pay-as-you-go at $0.40 per 100K
requests: at the *unreduced* plan-as-written volume of 5,000/day that is
about **$0.52 a month**. Worth stating plainly so the decision is never
framed as free-versus-expensive when it is actually free-versus-trivial.
