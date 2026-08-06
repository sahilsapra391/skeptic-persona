# Owner memo: Bluesky app password — setup steps

**p5-13(b). One page, no build.** This is a five-minute task for the owner's
hands, not a decision. It is owner decision 5 only in the sense that the lane
stays frozen until the password exists.

## What you do

1. Sign in to Bluesky as the account this desk will read from.
2. Go to **https://bsky.app/settings/app-passwords**.
   (Reachable in-app under Settings, but the direct URL skips the hunt.)
3. Create a new app password and **name it for this use**, e.g. `skeptic-wire`.
   The name is how you revoke the right one later without disturbing anything
   else.
4. Copy the generated password. Bluesky shows it **once**.
5. Hand it over for `wrangler secret put` — it never goes in a file, a commit,
   or a message. Same handling as `TELEGRAM_BOT_TOKEN`.

That is the whole task.

## Why an app password and not the account password

The AT Protocol SDK guidance is explicit:

> If you are using password auth, you should generate an app password for your
> account rather than using your main account password.

An app password is scoped and independently revocable. If this pipeline is ever
compromised, you revoke one credential and the account itself is untouched.
Handing over the real password would make the blast radius the whole account,
and there is no reason to accept that for a read-only discovery lane.

## Why not OAuth, given atproto is moving that way

Also from the same guidance:

> Applications with an end user login flow should use OAuth authentication
> rather than app password sessions.
>
> Password auth is acceptable for bots and command line tools.

OAuth is becoming the primary path for atproto clients, and app passwords are
expected to recede over time. But the distinction is about **who is logging
in**. OAuth exists so an app can act on behalf of *its users*; this desk has no
users to log in, only itself. It is a bot, which is the case the guidance
names as acceptable for password auth.

So an app password is the right credential today, and the thing to watch is
whether Bluesky eventually retires them for bots too. Nothing to do about that
now beyond knowing it is the direction.

## What this does and does not unblock

**Does:** removes the owner-side blocker on p5-25, the Bluesky polling lane.

**Does not:** start the lane. p5-25 is `blocked-gate` behind the ten-post gate
and Phase 0 regardless, and the lane's own design is
**discovery-never-citation** — Bluesky can point us at something, and the post
still cites the primary document, never the skeet. The password does not soften
that; it is a charter rule, not a plumbing one.

## The one thing to get right

Name the app password so it can be revoked in isolation. An unnamed credential
in a list of unnamed credentials is one you will not dare to revoke later,
which quietly turns a scoped secret back into a permanent one.
