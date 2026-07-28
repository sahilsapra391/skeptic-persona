# Threads account ban — incident and park record

**Date:** 2026-07-28
**Account:** @skeptictradess (Threads)
**Outcome:** banned by Meta on suspected bot activity; publish path parked.

## What happened

The account became inaccessible. Meta's stated reason was suspected bot
activity.

Timeline from our own logs:

| time (UTC) | observation |
|---|---|
| 2026-07-28 01:07Z | last successful publish; the Threads API accepted a post normally |
| ~2026-07-28 03:00Z | Threads READ API begins returning `error.code 1`, "An unknown error occurred" |
| 2026-07-28 04:00Z | ban confirmed; profile inaccessible |

**18 posts** were published before the ban, every one of them human-approved
through the Telegram queue. Their `post_log` rows carry real Threads media ids
and are history: no migration in this track touches them.

## How we know this is a ban and not a token failure

The verified token-invalid signal on Threads is **HTTP 500 with JSON
`error.code` 190** (documented 2026-07-26 in
`2026-07-26-p1-sources-and-platforms.md`, and the reason the client never
trusts status class alone). The errors observed at 03:00Z were **code 1**, not
190, and publishing had succeeded under the same token less than two hours
earlier. The long-lived token does not expire until 2026-09-25 and the weekly
refresh job had been running normally.

`ThreadsError.isTokenInvalid` correctly classifies code 1 as *not* a token
problem; there is a regression test for exactly that discrimination in
`test/poster.test.ts`.

## Likely cause, and what it means for X

Not diagnosable from our side, but the plausible reading: a new account with no
follower graph, publishing structured near-identical short items on a schedule,
each carrying an external link. That is the shape of a feed bot regardless of
whether the API calls themselves were authorised, and we were using the
official API with an approved token throughout.

Moving to manual posting on X removes the *automation* signal. It does **not**
remove the looks-like-a-feed-bot signal. Carried into the X work as standing
constraints: lower volume, source link in a reply rather than the post body
(X deprioritises external links and t.co bills 23 characters regardless), and
materially more variation in post shape. The commentary layer in `p2r-04` is
the main instrument for that last one, which is a better justification for it
than "edgier".

## What was parked, and why parked rather than stripped

An appeal is outstanding. Stripping would orphan 18 real post ids, and
`src/poster.ts` + `src/lib/threads.ts` + `src/threadsOauth.ts` are the only
record of a Threads client verified working against the live API.

| surface | state |
|---|---|
| `THREADS_PARKED` in `src/poster.ts` | `true`; checked before `POSTING_ENABLED` in both entry points |
| `runPoster` | returns immediately; this also short-circuits `reconcileClaims` |
| `refreshThreadsToken` | returns immediately; the token is not being kept alive |
| `/threads/oauth/*` routes | unrouted in `src/index.ts`; the module stays on disk |
| `poster`, `threads_token_refresh` jobs | `enabled = 0` (migration 0026) |
| `POSTING_ENABLED` | `"false"` in wrangler.toml, defence in depth only |
| `THREADS_APP_ID` / `THREADS_APP_SECRET` | secrets left in place, unread while parked |

`THREADS_PARKED` deliberately outranks `POSTING_ENABLED` so that flipping the
config var back to `"true"` cannot reach a dead API.

**What parking `reconcileClaims` actually saves, stated precisely.** An earlier
draft of this record claimed the unparked reconciler was writing noise into
`source_state.last_error`. That was wrong and is corrected here: the poster
never calls `recordSourceError` (only ingesters do), and `reconcileClaims`
catches its own `listRecentPosts` failure, logs at warn and returns, so the
dispatcher's `consecutive_failures` counter never increments either. The real
cost of leaving it running was a recurring warn line in the tail every five
minutes. Worth removing, but it was never corrupting a monitoring surface.

## Why not the auto-recovering daily probe

The four egress failures (Senate eFD, NSE India, treasury.gov on two hosts) are
parked on a daily probe that lets the source return on its own. A ban is a
different kind of failure and gets a different treatment:

- polling cannot detect reinstatement in a form we could act on, and hammering
  a banned endpoint is precisely the behaviour that got us banned
- even a successful appeal needs a manual browser OAuth round, because the
  long-lived token expires 2026-09-25 and a dead token cannot be refreshed

So un-parking is deliberate and three-step: flip `THREADS_PARKED`, re-enable
the two `jobs` rows, re-run `/threads/oauth/start` after restoring the routes.

## Reconciliation left deliberately frozen

A `post_log` row with `platform_post_id IS NULL` is a pre-claim: the isolate
died between claiming and confirming. The reconciler normally resolves these by
reading the account's recent posts and either confirming or releasing them.

That question is now unanswerable, so any such row stays exactly as it is.
Releasing it would re-queue a post that may well have gone out before the ban.
There is a test asserting the frozen behaviour so a future cleanup does not
helpfully restore the reconciler.

## Doctrine debt created here

The publish-time register check in `runPoster` — the last automated gate before
text reached the world — is now inside unreachable code. `checkRegister` itself
remains fully covered in `test/templates.test.ts`, but the integration must be
reinstated on the generation path in `p2r-04`. Until then the last gate is the
owner reading the Telegram card before pasting.
