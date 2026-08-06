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

## What this file does not cover

SEC, FDA, BLS, Federal Register, Nasdaq and the central-bank sources are
public-record feeds with no click-through terms; the repo's standing rules
(declared User-Agent, rate limits, no spoofing, primary sources only) govern
them and are recorded in CLAUDE.md and `docs/SOURCE_REGISTRY.md`.

Vendor data is excluded outright by non-negotiable #3 and is not a licensing
question at all.
