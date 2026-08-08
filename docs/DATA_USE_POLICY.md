# Data use policy

Sits alongside [EXCLUSIONS.md](EXCLUSIONS.md). That file records what this desk
will not ingest; this one records the terms under which it uses what it does.

## Congressional disclosure data (Senate eFD, House Clerk)

**Owner decision, 2026-08-06.** The owner authorizes acceptance of the eFD
access terms on behalf of Skeptic, and the poller transmits that acceptance
each session.

Mechanically, that is the `prohibition_agreement=1` POST in `handshake()`
(`src/ingesters/senatePtr.ts`). It was already in the code; what changed on
2026-08-06 is that it is now **authorized rather than assumed**.

### The conditions, and they bind both chambers

1. **Free public dissemination with attribution.** Congressional disclosure
   data is used solely for the news and communications media use: published
   free, to the public, with its source named. Every post carries its
   attribution; that is not a style choice here, it is the licence condition.
2. **Never for credit determination, solicitation, or resale.** No credit or
   underwriting use, no using a filer's disclosures to solicit them or anyone
   else, no reselling the data or a derivative of it.
3. **The same fence governs the House lane.** The House Clerk's bulk index and
   PDFs sit under the same statute, and nothing in this policy treats them as
   looser because their access has no click-through.
4. **Paid productisation stops the line.** If congressional data is ever
   proposed as a paid Skeptic product feature, **work stops for a qualified
   legal review before any build.** Not after a prototype, not alongside one.

### Why the automation refused to decide this

While diagnosing the eFD outage on 2026-08-06, a subagent established that the
data endpoint answers a csrftoken-only jar 27 times out of 27 and that the
agreement POST was therefore the likely failure point. It **declined to test
the agreement POST**, and said why:

> "Accepting a terms/prohibition agreement on the user's behalf needs his
> explicit say-so, not a task instruction."

**Logged as correct behaviour.** Accepting terms on someone's behalf is a
decision with legal weight, and a task instruction to "fix senate_ptr" is not
consent to it. The right move was to surface it as the highest-value untested
step and stop, which is what happened. This section exists so the next session
finds a ruling rather than re-deriving the question.

## Figures: quoted from parsed data, linked from prose

**The methodology rule the earnings signature line cites.** A figure is quoted
only when it is verifiable from **parsed source data** — a field an ingester
actually read out of a structured record. A figure that exists only in prose is
**linked, never retyped**.

That is why an earnings post states that results were filed and where to read
them, and states no result. Item 2.02's numbers live in Exhibit 99.1, a press
release; retyping one would put a figure in a post that no ingester parsed, and
a misread decimal in an earnings number is the most damaging thing this desk
could publish.

The rule is registered in `src/rag/definitions.ts` as
`figures-quoted-only-from-parsed-data`, so a signature line invoking it **binds
under the aphorism scorer's cash-out test** rather than backing onto nothing.
It renders as fixed furniture on every earnings card.

## What this file does not cover

SEC, FDA, BLS, Federal Register, Nasdaq and the central-bank sources are
public-record feeds with no click-through terms; the repo's standing rules
(declared User-Agent, rate limits, no spoofing, primary sources only) govern
them and are recorded in CLAUDE.md and `docs/SOURCE_REGISTRY.md`.

Vendor data is excluded outright by non-negotiable #3 and is not a licensing
question at all.

## Outstanding: the pre-rewrite blobs (B-16.4)

**Our attributed-redistribution commitment is not met until these are gone.**

`test/tmp-payloads.ts` carried congressional periodic-transaction data for 39
named members as a raw payload dump with no attribution. It was removed from
branch history by `git filter-repo` on 2026-08-06, but a history rewrite cannot
evict objects GitHub has already stored, and the blob remained fetchable by
direct SHA afterwards.

A GitHub Support purge ticket was filed 2026-08-08 with the exact SHAs
(`docs/verification/2026-08-08-github-purge-ticket.md`).

| | |
|---|---|
| Status | **OPEN — awaiting GitHub Support** |
| Blob | `8bcea4dfc1d3f357d6e487091a04bd0a8f343587` (249,656 B) |
| Also filed | two unprojected OpenFIGI fixtures |
| Closes when | Support confirms, AND a direct-SHA fetch returns 404 |

Record the closure here when both conditions hold. Until then this policy has a
known, dated gap rather than an implied clean bill.
