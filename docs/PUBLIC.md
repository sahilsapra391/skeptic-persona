# This repo is public on purpose

Owner ruling, 2026-08-07: **skeptic-persona stays public, permanently.**

It was public from creation, which was not a deliberate choice at the time. It
is one now. This file exists so the openness reads as a decision rather than an
oversight, and so anyone who clones it knows what they are looking at and what
they may do with it.

## What this is

Skeptic Wire is an automated market-intelligence desk that publishes to X as
[@SkepticTrades](https://x.com/SkepticTrades). A Cloudflare Workers pipeline
ingests primary-source filings and releases, scores them, drafts commentary,
and pushes candidates to a Telegram approval queue.

**Publishing is manual.** The pipeline never posts. It hands a human
copy-ready text and that human decides. `POSTING_ENABLED` is `false` in
production and there is no automated publish path to defend.

The interesting part of the codebase is not the plumbing. It is the set of
rules the desk refuses to break, and the machinery that enforces them:

- Every number in a post comes from a field an ingester actually parsed. If a
  field did not parse, the post does not claim it.
- Primary sources only. Filed, printed, or released by an official source. No
  "reportedly", no vendor data republished as fact.
- Every post carries its source link.
- Honest identity. Brand-affiliated, never a fake human, never denies being
  automated.

Those are enforced by validators, not by good intentions. `src/rag/validate.ts`
and `src/templates/validate.ts` are where a draft goes to die if it makes a
claim its payload cannot support.

## What is genuinely useful here if you are reading it

- **`docs/verification/`** is the most valuable directory. Every external
  endpoint this project depends on was live-probed, and the result was written
  down with a date: what the response actually looked like, which
  Content-Type headers lie, which hosts block datacenter IPs, which return a
  200 with an error page inside. If you are building against SEC EDGAR, Senate
  eFD, the House Clerk, BLS, Treasury, CFTC, or OpenFIGI, some of that will
  save you an afternoon.
- **`docs/p5-ledger.md`** records defects as they were found, including the
  ones this project caused itself, with the reasoning that produced them. It is
  deliberately not cleaned up.
- **`src/render/`** encodes PNG cards inside a Worker with zero runtime
  dependencies, using `CompressionStream("deflate")` and a build-time bitmap
  font atlas.
- **`src/templates/length.ts`** implements X's weighted character count, which
  is not `String.length` and is wrong in both directions if you assume it is.

## What you may do with it

The code carries no licence grant at this time, so default copyright applies:
read it, learn from it, cite it. Ask before reusing it wholesale.

The **data** it processes has its own terms, and they are stricter than the
code's:

- Congressional financial disclosure (House Clerk, Senate eFD) is free public
  data usable **with attribution only**. It may never be used for credit
  determination, solicitation, or resale. See
  [`docs/DATA_USE_POLICY.md`](DATA_USE_POLICY.md).
- FIGI identifiers are dedicated to the public domain by Bloomberg. The
  associated security *descriptions* are not, which is why the cached OpenFIGI
  fixtures in `test/fixtures/` were reduced to the three fields the code
  actually reads. See
  [`docs/verification/2026-08-06-public-exposure-response.md`](verification/2026-08-06-public-exposure-response.md).
- Everything else this pipeline ingests is a government primary source.

## What is not here

No secrets have ever been committed to this repository. That is not a claim of
diligence, it is a measurement: a full-history `gitleaks` scan across every ref
returned zero findings, and `.dev.vars` has never appeared in any tree. All
credentials live in Cloudflare Worker secrets and GitHub Actions secrets.

Operationally sensitive material does not belong here either, now that public
is permanent. Specifics on courier host behaviour and egress fingerprinting
move to a private ops repo going forward. What is already in this history stays
public; that is accepted rather than pretended away.

## The security assumption

An attacker can read every parser, every validator, and every threshold. The
project is built as if that were always true, because now it is. Notably:

- There is no automated publish path. The worst outcome of a poisoned input is
  a bad draft that a human declines.
- Vendor wire items (GlobeNewswire, PR Newswire) are attacker-influenceable by
  design, since anyone can pay to issue a press release. They are stored at
  log-only score and **can never be enqueued**, by construction rather than by
  policy. See `src/ingesters/prWires.ts`.
- Fork pull requests receive no secrets. The only workflow reachable from a
  `pull_request` event references none, and the secret-bearing workflows run
  only on `schedule` and `workflow_dispatch`.

## Contact

admin@spechawk.ai. If you find something wrong, particularly a case where a
post could state a number no source supports, that is the bug this project
most wants to hear about.
