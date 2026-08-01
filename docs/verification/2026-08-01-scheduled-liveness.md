# A quiet pipeline and a dead one look identical from `items`

**Written 2026-08-01**, after nearly reporting an outage that was a Saturday.

## What it looked like

At 22:08 UTC on Saturday 1 August, six hours of ingest history held **two
sources**:

```
source                    n
treasury_auction         12
press_cftc_enforcement   10
```

Every other source silent. Both of those arrive via the GitHub Actions relay
rather than the Worker's own polling, so the natural reading is that the
Worker had stopped.

## What was actually true

The dispatcher was scheduling normally. The discriminator is not ingest
recency, it is whether anything is **overdue**:

```sql
SELECT COUNT(*) AS due_now FROM jobs
 WHERE enabled = 1
   AND due_at <= strftime('%Y-%m-%dT%H:%M:%S.000Z','now');
-- 0
```

Zero due, and the future `due_at`s say why:

```
halts_nasdaq    2026-08-03T08:00:00Z   <- Monday open
bls_calendar    2026-08-02T13:30:00Z
bls_watch       2026-08-04T13:58:30Z   <- a specific BLS release window
```

Markets were closed, the agencies were not publishing, and the market-windowed
sources had correctly parked themselves days out. Nothing was wrong.

## The rule

**Recency of output is not evidence of liveness for a scheduled system.** A
source that produces nothing because there is nothing to produce is
indistinguishable, from the output table alone, from one that has stopped.

To tell them apart, ask the scheduler rather than the output:

| Question | Query |
|---|---|
| Is anything overdue? | `COUNT(*) FROM jobs WHERE enabled=1 AND due_at <= now` |
| When does each next fire? | `SELECT name, due_at FROM jobs WHERE enabled=1 ORDER BY due_at` |
| Has anything never run? | `SELECT name FROM jobs WHERE enabled=1 AND last_ok_at IS NULL AND due_at <= now` |
| Is a source failing rather than idle? | `source_state.consecutive_failures`, never `jobs.consecutive_failures` |

The last row matters for a separate reason recorded in
`sourceHealth.ts`: `jobs.consecutive_failures` reads zero for every source,
because the dispatcher only increments it when a handler *throws*, and every
polling ingester catches its own fetch error and returns normally.

## It generalises past the weekend

The same reasoning applies to anything whose output is event-driven:

- an empty digest tomorrow morning is not proof the salience layer is broken
- zero PTR cards during a congressional recess is the correct output
- no rate-decision post between meetings is the system working

In each case the liveness question is "did the job run and find nothing", and
only the scheduler can answer it. `due_now = 0` with sensible future
`due_at`s is a healthy system; the same zero with `due_at`s in the past is a
stuck one, and those two states are invisible to any query over `items`.
