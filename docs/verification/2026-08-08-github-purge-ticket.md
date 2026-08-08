# GitHub Support purge ticket — the exact facts (B-14.5)

Everything a Support request needs. Every SHA below was confirmed **still
fetchable from GitHub at the time of writing**, which is the reason the ticket
is necessary: `git filter-repo` rewrote the branch history, but it cannot evict
objects GitHub has already stored.

## Repository

```
sahilsapra391/skeptic-persona
```

## Pre-rewrite commit

```
cdd2ad36c1284da113b56378b00224fcaba79a9f
```

That was `main` immediately before the history rewrite on 2026-08-06. It still
resolves through the API today.

## Blobs to purge

| SHA | Bytes | Path | Confirmed reachable |
|---|---|---|---|
| `8bcea4dfc1d3f357d6e487091a04bd0a8f343587` | 249,656 | `test/tmp-payloads.ts` | yes |
| `8207c09acc9078192d5eafc818c5bce99c9d89f7` | 486,408 | `test/fixtures/openfigi-batch1.json.fixture` | yes |
| `3d06f848ac4d7bc23aa298cddd0622289a33debd` | 332,074 | `test/fixtures/openfigi-batch2.json.fixture` | yes |

All three return their full byte count from
`GET /repos/sahilsapra391/skeptic-persona/git/blobs/<sha>`.

## Commits that carried `test/tmp-payloads.ts`

```
21a7bb5   added it   (D-31 ruling: provenance beats bind, metaphor beats retire)
adf011f   removed it (Remove two subagent scratch files git add -A swept in)
```

## What to ask Support for

> Please garbage-collect and purge cached views for the following blob SHAs and
> the pre-rewrite commit in `sahilsapra391/skeptic-persona`. The repository
> history was rewritten with `git filter-repo` on 2026-08-06; these objects are
> no longer referenced by any branch or tag but remain fetchable by direct SHA
> through the API.

## Why each one

**`test/tmp-payloads.ts`** carries congressional periodic-transaction data for
39 named members: name, asset, transaction type, date, amount band. It is
statutorily public disclosure and contains no SSN, address, email, phone,
account number or date of birth. It is not a credential leak. The reason it is
being purged is our own standard: `docs/DATA_USE_POLICY.md` commits this desk to
redistributing that data **with attribution**, and a raw payload dump carries
none.

**The two OpenFIGI fixtures** are verbatim third-party API responses. Bloomberg
dedicates FIGI *identifiers* to the public domain but the associated security
*descriptions* are a separate defined category the terms are silent on, and
silence is not permission. The current fixtures are projected down to the three
fields the code actually reads; these are the unprojected originals.

## Scope, stated honestly

This ticket addresses objects GitHub still stores. It cannot address anything
already cloned: the repository has been public since 2026-07-26 and recorded
655 clones from 13 unique cloners. The exposure snapshot (D-57) reads that as
CI traffic rather than discovery — 0 forks, 0 stars, and one unique page
viewer, who is the owner — but the bound is real and is recorded rather than
implied away.
