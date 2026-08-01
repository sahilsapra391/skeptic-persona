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
- The validator gauntlet did real work on real output: `dry` and `sharp`
  validated, `commentary` was rejected `length` on attempt 1 and
  `entity` on attempt 2 (the model named "April Maduro charge" and "May pool
  fraud judgment" — lake context it had seen but which was not in THIS item's
  payload). That is the no-fabrication floor doing exactly its job on live
  model output.

**Model quality note, recorded because it is a product input:**
`qwen/qwen3.7-flash` is a fast/cheap tier and it shows. The `sharp` beat it
produced was `pay $35,000.` — a lowercase fragment echoing the fact block.
Doctrine-legal, so no validator caught it; it is a WRITING failure, not a
truth failure. Closed with `beatShapeCheck` (a beat is a sentence), but the
underlying signal is that a stronger model would likely clear the commentary
contract more often. Worth revisiting `OPENROUTER_MODEL` once there is a
zero-edit rate to compare against.

Env contract (listed in the PR): `OPENROUTER_API_KEY` (secret),
`OPENROUTER_MODEL` (var — model id is config, never code).
