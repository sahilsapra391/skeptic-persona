# The Telegram delivery hang: diagnosis, fix, and live verification

**Incident:** 2026-08-05, approval cards stopped reaching the owner at
**04:05 UTC** and did not resume until **18:01 UTC**. Ten hours, 21 cards,
zero alarms.

## 1. What the owner saw

No approval prompts all morning, then roughly ten messages arriving at once at
2:01 PM ET. His read was that something had pushed them manually. That was
close to right: **my push caused it, though not by sending anything.**

## 2. The false trail, recorded because it was mine

I first concluded the break was external (revoked token, blocked bot). The
reasoning was: no deploy sat between the last success and the first failure,
so no code change could be responsible.

That was wrong, and the error was treating **silence as absence**. Twenty-four
minutes of `wrangler tail` captured no `telegram notify failed` line, which I
read as "no send was attempted". The truth was the opposite: a send was
attempted and never finished. A hang produces exactly the same empty log as an
idle system.

## 3. Root cause

`lib/telegram.ts` paced sends per chat by storing a **promise**:

```js
const wait = chatGates.get(chatId) ?? Promise.resolve();
const hold = wait.then(() => new Promise((r) => setTimeout(r, spacingMs)));
chatGates.set(chatId, hold.catch(() => {}));
return wait;
```

A Cloudflare Workers invocation **does not run pending timers once it ends**.
When a tick's last act was a send, the tick finished before that 1100 ms timer
fired, so `hold` never resolved. `chatGates` kept it. Every later send in that
isolate awaited a promise that could never settle: **no message, no rejection,
no log**.

`crons = ["* * * * *"]` is why it lasted ten hours rather than minutes. A tick
every 60 seconds keeps the isolate warm, so nothing evicted the poisoned one.
Only a deploy could replace it.

## 4. The evidence, in order

```
03:45:15Z  last deployment before the outage
04:04:36Z  two cards sent (tg 1126, 1127) — this tick's LAST act was a send
04:05:36Z  next tick, same isolate: hung. telegram_message_id NULL, no error
04:05 - 14:21   every card NULL, ingestion healthy, all jobs reporting OK
18:00:32Z  my ledger commit pushed
18:01:24Z  Workers Build deploys it — new isolate
18:01:36Z  cards #1079-#1087 created and sent as tg 1129-1137
```

Those nine are the owner's "ten messages at 2:01 PM". They are **not** resent
backlog; they are new cards that succeeded because the isolate was replaced.

The earlier intermittency fits the same mechanism: 01:04:36 failed, 03:04:36
succeeded, because a two-hour quiet gap let that isolate be evicted naturally.

Introduced 2026-08-01 in #91. First failures 08-03, the first real-volume day
after it: 2 on 08-03, 13 on 08-04, then the total outage.

## 5. The fix

`paceChat` now reserves a **timestamp**, not a promise.

What is kept: ordering. The original chose a chain because arrival order
matters as much as the gap, and that reasoning was sound. The slot is still
reserved **synchronously**, before any await, so concurrent callers still
serialise in arrival order.

What changes: the cross-invocation state is an integer. A timer is awaited
only by the invocation that created it, so an invocation dying mid-wait harms
only its own send. A stale integer can make one caller wait at most
`MAX_PACE_WAIT_MS` (5 s). **It cannot hang.**

### The regression test was verified against the bug

A test that passes on the broken code proves nothing, so I reverted `paceChat`
to the old implementation and ran it:

```
FAIL  REGRESSION: a discarded timer from a previous invocation must not hang the next send
Error: Test timed out in 15000ms.
```

It **times out** rather than fails, which is precisely how production behaved.
On the fix it passes. `vi.clearAllTimers()` models the real event: timers
scheduled by a finished invocation are discarded without firing.

## 6. Defence in depth, because the pacing bug was only one way to lose a card

Telegram can 429, 5xx, or go down. Every one of those must degrade to
**delivered late**, never **lost**. Before this, `enqueue.ts` caught the error,
logged one line, and moved on. Its own comment said the quiet part: *"Queue row
survives; the expiry job will sweep it if nobody notices."*

`notify_retry` (every_5m) re-sends pending cards whose `telegram_message_id` is
still NULL:

- **bounded** by `MAX_NOTIFY_ATTEMPTS`, so one permanently-rejected row cannot
  spend the notify budget every tick and starve fresh cards behind it
- **TTL-aware**, using the same per-archetype cutoffs `queue_expiry` uses, so
  it never hands back a card the owner can no longer act on
- **counts the attempt before sending**, so a throw arriving after Telegram
  already accepted the message cannot deliver the same card forever

## 7. Live verification

Migration 0064 applied to production before merge. Merged as `5c9c29b` (#140).

Watched the backlog drain in production, 5 per 5-minute run exactly as
`NOTIFY_RETRY_LIMIT` specifies:

```
21 -> 16 -> 11 -> 6 -> 1 -> 0
```

Final state:

```
undelivered = 0
new cards delivered since the fix = 8
new cards FAILED since the fix    = 0
notify_retry consecutive_failures = 0
```

Both halves are proven by that: the pacing fix (8 new cards, none failed) and
the recovery path (all 21 stranded cards delivered).

## 8. What this changes about how I read a quiet log

The lesson is not "check the tail harder". It is that **an empty error log is
not evidence of health**, and this pipeline had no positive signal for
delivery at all: `source_state` tracks ingest failures with counters and
quarantine, while the one channel the owner actually reads could fail
completely with every job reporting green.

It also corrupted a number I had already reported. I told the owner the
approval rate fell 19 to 10 and called it a worsening flood. Part of that drop
was simply cards he never received. Approval rate and delivery rate are not
independent, and the north-star block should say so.
