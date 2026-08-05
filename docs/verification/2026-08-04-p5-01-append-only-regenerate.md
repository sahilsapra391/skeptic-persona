# p5-01 verification: Regenerate is append-only

**Verified:** 2026-08-04 / 2026-08-05 UTC, against the live `skeptic-wire` D1
database (`d951177f-e4ab-4b6b-a014-efc7d78d065e`) and the deployed Worker.

## 1. The defect, measured in production before the change

The count is the evidence. `generations.id` is `INTEGER PRIMARY KEY
AUTOINCREMENT`, so `MAX(id)` is the number of rows ever inserted:

```
SELECT COUNT(*) AS gen_rows, COUNT(DISTINCT queue_id) AS gen_queues, MAX(id) AS max_id FROM generations;
-> {'gen_rows': 47, 'gen_queues': 11, 'max_id': 96}
```

47 rows survive against 96 ever written. Roughly **49 drafts were destroyed**
by `DELETE FROM generations`, and they are not recoverable. This chunk stops
the loss; it does not invent the rows already gone.

## 2. Queue and post state at the time of the change

```
SELECT state, COUNT(*) FROM queue GROUP BY state;
-> expired 919, pending 134, approved 11, rejected 1   (1,065 cards total)

SELECT COUNT(*), COALESCE(SUM(posted_manually),0), MIN(posted_at), MAX(posted_at) FROM post_log;
-> 18 rows, 0 manual, 2026-07-27T18:58:16Z .. 2026-07-28T01:07:04Z

SELECT posted_state, COUNT(*) FROM cards GROUP BY posted_state;
-> NULL: 11
```

Two independent reads agree the **manual-post counter is 0**: no `post_log`
row has `posted_manually = 1`, and no `cards` row has `posted_state` in
(`yes`, `modified`). The 18 `post_log` rows are Threads-era AUTOMATED posts
from before the ban, which count as approvals and do NOT count toward the
10-post gate.

Approvals counted per the #115 rule (`queue.state='approved'` UNION
`post_log`): 11 + 18 with **zero overlap** and zero NULL `queue_id` = **29**,
against 1,065 cards. The plan's snapshot said 29 of 1,064. Consistent; one
card has been created since. No conflict.

## 3. Migration applied to production BEFORE the code deployed

Ordering is not incidental. The schema guard now lists `queue.regen_cycle` in
`REQUIRED_SHAPE`, so a deploy that landed before the migration would make the
webhook refuse the owner's taps. Additive columns are invisible to the
already-deployed code, so applying first is the safe order.

```
wrangler d1 migrations apply skeptic-wire --remote
-> 0063_generation_cycles.sql  ✅  (4 commands)
```

Post-apply consistency, live:

```
gen_rows        47
gen_cycle0      47      -- every existing draft is cycle 0
q_rows        1065
q_cursor0     1065      -- every existing queue row has cursor 0
live_cycle_rows 47      -- g.cycle = q.regen_cycle for ALL 47
idx_generations_queue_cycle  present
```

`live_cycle_rows == gen_rows` is the assertion that mattered: every existing
generation row still matches its queue row's current cycle, so the new
`g.cycle = q.regen_cycle` join in `deliverCards` orphans **no** existing card.
A mismatch here would have silently stopped delivery for live rows.

## 4. Migration number collision, caught before merge

This session branched from `0579ff5`, before the 13F lanes merged. Main had
since added `0060_form13f.sql`, `0061_managers13f_seed.sql` and
`0062_diffs13f.sql`, so the file first written here as
`0060_generation_cycles.sql` duplicated an existing prefix.

Renumbered to `0063_generation_cycles.sql`. Because the file had ALREADY been
applied to production under the old name, the `d1_migrations` ledger row was
renamed to match:

```
UPDATE d1_migrations SET name='0063_generation_cycles.sql' WHERE name='0060_generation_cycles.sql';
-> 1 command
SELECT id, name FROM d1_migrations ORDER BY id DESC LIMIT 5;
-> 56 0063_generation_cycles.sql / 55 0062_diffs13f.sql / 54 0061_managers13f_seed.sql
   / 53 0060_form13f.sql / 52 0059_poll_counters.sql
wrangler d1 migrations list --remote
-> No migrations to apply!
```

Left unrenamed, wrangler would have seen `0063_generation_cycles.sql` as
pending, re-run `ALTER TABLE ... ADD COLUMN`, failed on the duplicate column,
and blocked every migration after it.

Also confirmed while here: the 13F migrations were already applied at
2026-08-05 00:38 and all four tables (`filings_13f`, `holdings_13f`,
`managers_13f`, `diffs_13f`) exist. No merged-not-migrated gap.

## 5. Deployed behaviour matches merged code

See section 7 below for the post-merge live check.

## 6. What CI did and did not prove

**GitHub Actions CI is `disabled_manually`** (`gh workflow list --all`:
`CI  disabled_manually  321008370`). The workflow file is present and
unchanged on main; the workflow itself is switched off at the repo level. No
pull request has been tested by CI since run 30964438778 at 00:48 UTC, and
PR #133 reports only a Workers Builds check.

So the green suite behind this chunk is a **local** run, stated plainly:
1,017 passing, 1 failing. The failure is D-6, which fails identically on clean
main and is caused by the untracked local `.dev.vars` supplying a real
`OPENROUTER_API_KEY` to a test named "does nothing unconfigured". In CI that
file is absent and the test passes, which is why it was never noticed.

Not re-enabled unilaterally: disabling was a deliberate manual act with
Actions-minutes cost, and ci.yml's own comment cites account-wide private-repo
minutes as the reason it is already PR-only. Owner decision, feeding p5-02.
