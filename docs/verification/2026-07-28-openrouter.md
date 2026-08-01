# OpenRouter chat completions — verification

**Verified:** 2026-07-28 (unauthenticated probe; full round-trip still owed)

## What was verified live

```
POST https://openrouter.ai/api/v1/chat/completions
Content-Type: application/json
{"model":"test","messages":[{"role":"user","content":"hi"}]}
```

Response: **HTTP 401** with body

```json
{"error":{"message":"No cookie auth credentials found","code":401}}
```

So, verified facts the client is built against:

- The endpoint exists at that exact path and answers JSON.
- The error envelope is `error.message` + numeric `error.code` — same shape
  family as Threads, and like Threads the classifier must read the body, not
  just the status class.
- Unauthenticated = 401, which is what `OpenRouterError.isAuthInvalid` keys on
  for the alert-once-don't-retry path.

## What is NOT yet verified, deliberately flagged

A full authenticated round-trip (request → completion → token accounting)
requires `OPENROUTER_API_KEY`, which is an owner-provisioned secret that does
not exist yet. **The moment the key is set, run one real completion against
the configured `OPENROUTER_MODEL` and append the result to this record** —
until then, treat the request/response field names in the success path
(`choices[0].message.content`, `max_tokens`, `temperature`) as documented but
not live-verified. `parseVariants` is written defensively for exactly this
reason: it assumes the model wraps JSON in prose until proven otherwise.

## echo_ngrams was empty in production for four days — recorded 2026-08-01

The corpus-echo check shipped 2026-07-28 with `scripts/build-echo-hashes.mjs`
written but never run. `SELECT COUNT(*) FROM echo_ngrams` returned **0** until
2026-08-01, so every generated draft passed that check by default. It degraded
open by design (style similarity is not doctrine, unlike the group-1 floor
which fails closed), and it logged a warn once per run — which nobody read.

Found only because the ingestion session asked, about a different subsystem,
whether a validator can tell *"not there"* from *"not loaded yet"*. Mine could
not.

**Loaded 2026-08-01: 726,579 salted 8-gram hashes from 34,092 corpus posts.**
Hashes only; no third-party text is in the repo or the database.

Verified discriminating against production, not asserted:

| probe | hits in `echo_ngrams` |
|---|---|
| three 8-grams from a real corpus post | **3 of 3** |
| three 8-grams from an owner exemplar | **0 of 3** |

False-rejection risk measured before loading: all **30 owner exemplars** and
all **3 live generated texts** produce zero collisions against the full set.

Loading notes for whoever reloads it: `wrangler d1 execute --file` fails on
4.35.0 with a Node `FileHandle`-closed-during-GC error, and `--command`
batches above roughly 6,500 hashes are rejected. 5,000 per command, 146
commands, works.

The code now alerts once per 24h when the table is empty rather than logging a
warn, because a check that is off must say so.

## Live round-trip — VERIFIED 2026-08-01

The owed verification. `OPENROUTER_API_KEY` was set (Cloudflare dashboard; the
CLI `wrangler secret put` path fails on 4.35.0 whenever an undeployed branch
build-check version is newer than the deployed one) and
`OPENROUTER_MODEL = "qwen/qwen3.7-flash"` shipped in wrangler.toml. First real
generation fired at 19:40Z on queue row #918 (REGULATORY_NEWS, a CFTC
enforcement order).

Confirmed against production data, not inference:

- The success-path field names are correct as written:
  `choices[0].message.content` carried the completion, and `parseVariants`
  extracted all three variants from one call.
- One call produced all three variants; the retry path fired exactly once,
  for the variant the validator rejected, as designed.
- `max_tokens: 2048` was ample; no `finish_reason: "length"` truncation.
- The validator gauntlet did real work on real output: `commentary` was
  rejected `length` on attempt 1 and `entity` on attempt 2.

**CORRECTED 2026-08-01** (the p4 session caught this, and the sharper reading
is the useful one). The first version of this record said attempt 2 died
because the model used lake context that was not in the payload. That is
wrong. Since p4-01 the whitelist is payload ∪ source document ∪ lake context
(`groundingFacts` + `mergeFacts`), so everything the prompt showed is
licensed — and attempt 1 proves it, quoting "Nicolás Maduro-Related Event
Contracts" and "9 enforcement actions since 2026-04-23" verbatim from context
and passing `entityCheck` cleanly before dying on length (293 vs 280).

What actually happened on attempt 2 is better: **squeezed under the length
budget, the model compressed "2026-04-23" and a name from a neighbouring title
into "April Maduro" — a two-word proper noun naming a person who does not
exist.** `entityCheck`'s multi-word-proper-noun rule caught it. So the finding
is not "it reached outside its grounding"; it is *lossy compression invented a
human being, and the floor stopped it.* Regression-pinned by the p4 session in
#71; full analysis in `2026-08-01-p4-01-grounded-generation.md`.

**Model quality note — CORRECTED 2026-08-01, and the correction is the
point.** The first version of this note read the `sharp` beat `pay $35,000.`
as evidence that `qwen/qwen3.7-flash` is too cheap a tier, and told the owner
the model id was the first dial to turn. The ingestion session pushed back:
check what the payload actually offered before blaming the model. Measured:

    queue #918 payload = 5 fields (authority, title, empty categories,
    publishedIso, factLine restating the title); raw_text length = 0

The model was handed a headline and a date. There was no second fact to build
a beat out of, so it echoed the only number it had. **A stronger model writes
more fluent prose around the same missing facts.** `OPENROUTER_MODEL` is the
right first dial for VOICE and the wrong one for SUBSTANCE; when a draft reads
thin, check `payload` and `raw_text` first. (`items.raw_text` was 0 of 10,825
rows at the time of this generation — it captures at ingest going forward, so
this item predates any source text.)

`beatShapeCheck` still stands on its own: a lowercase fragment is a writing
failure regardless of why the model reached for it.

Env contract (listed in the PR): `OPENROUTER_API_KEY` (secret),
`OPENROUTER_MODEL` (var — model id is config, never code).
