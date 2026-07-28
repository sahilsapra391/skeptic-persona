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

Env contract (listed in the PR): `OPENROUTER_API_KEY` (secret),
`OPENROUTER_MODEL` (var — model id is config, never code).
