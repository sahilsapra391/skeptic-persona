# P5 session handoff

Written 2026-08-08 at the P5 session's close, per B-16.5. From here the P6
session owns the main checkout and everything that follows. This is what
exists, where it lives, and the four things most likely to trip the next
person.

---

## 1. Lanes

**61 sources, 24,577 items.** 65 registered source rows, 62 healthy.

Delivered this program: Congress (House + Senate), 8-K events and bodies,
Form 4, Form 144, Form 25, Schedule 13D/G, 13F with breakdown cards, halts,
Reg SHO, FDA recalls, Federal Register, BLS, Treasury, CFTC, NOAA, eleven
central-bank rate lanes, twenty-one regulatory-press lanes, two PR wires, and
newly: **S-1/IPO** (`sec_s1`), **proxy contest** (`sec_proxy_contest`), and
**Bluesky discovery** (`bluesky_discovery`).

### Four lanes are DISCOVERY-ONLY by construction

`bluesky_discovery`, `sec_s1`, `sec_proxy_contest`, `wire_*`. Each ingests at
`SCORE_LOG_ONLY` with no archetype, no attribution entry and no
`enqueueForApproval` path. That is not a placeholder: social and vendor-wire
items are **discovery, never citation** (p4 mesh rule), and the two EDGAR lanes
have no exemplar bank yet. Tests assert this against the shipped source.

**p5-25 has been measured and stays log-only** (D-90). 0 of 121 items would
clear a corroboration bar: the high-volume terms are single-purpose EDGAR
republisher bots echoing lanes we already run directly, and the genuinely
diverse terms carry a cashtag in 1 of 25. Three measurable reopen conditions
are in `docs/verification/2026-08-08-p5-25-corroboration.md`.

### Currently failing

| Source | Fails | Note |
|---|---|---|
| `rate_bcb` | 57 | chronic, `no non-future observation`, pre-existing |
| `rate_boe` | 1 | transient 500 |
| `sec_form25` | 1 | transient timeout |

Only the first needs attention.

---

## 2. COMPLETION.md

`COMPLETION.md` on main is B-03.1's terminal artefact: what shipped, what was
excluded and why, what is blocked and on whom, and the generation numbers.
Its headline is still true and still the most important sentence in this repo:

> The pipeline works and has published nothing.

---

## 3. CI diet (D-83, D-84)

- **Concurrency group with `cancel-in-progress`.** Superseded PR runs are
  killed. Main is deliberately exempt via `github.run_id` — cancelling a main
  run would leave branch protection ambiguous about an already-merged commit.
- **Docs-only short-circuit.** A PR whose entire diff is `docs/*.md` or root
  `*.md` skips install/typecheck/tests **while still reporting the required
  `test` check**. A workflow-level `paths-ignore` would make the check never
  report and the PR unmergeable. Measured: **0.13 min vs a 1.57 min baseline,
  92% saved.**
- The classifier **counts** docs-shaped paths rather than using `grep -qv`,
  which is not portable between BSD and GNU grep and would have skipped the
  suite on a docs+code PR.
- `timeout-minutes: 10` as a runaway backstop.

**Still owed:** the monthly minutes/spend digest line. `GH_BILLING_TOKEN` is
now bound Worker-side and verified, and the data source is
`/repos/.../actions/runs` — **not** the billing endpoint, which returns
`410 Gone`.

---

## 4. D-number high-water mark

**D-91.** Claim the next number by pushing the ledger row early; two sessions
collided on D-85/D-86 because both claimed at the end of a chunk.

---

## 5. The exemplarCoverage guard

`test/exemplarCoverage.test.ts` **fails if any registered archetype has an
empty exemplar bank.**

This exists because the class recurred. B-08.4 fixed four archetypes by hand;
a later sweep found six more, four of them actively carding, and **53 cards had
been silently falling back to a voiceless template**. An empty bank does not
degrade gracefully — the gate refuses generation outright and nothing says why.

**If you register a new archetype, it needs at least one exemplar or the suite
goes red.** `STORM` and `TREASURY_AUCTION` are on a named exemption list
because they have never carded; if either starts carding, take it off the list
and give it a bank.

20 provisional exemplars are marked `provisional: true` **in the data**, so the
digest can count them and the replacement queue cannot drift. Owner or advisor
text replaces them one-for-one by archetype and register.

---

## 6. credcheck

`POST /admin/credcheck`, auth by `ADMIN_PROBE_TOKEN`.

Makes **one live authenticated call per credential** against the deployed
Worker and returns name, presence, HTTP status and an accepted flag. **Never
the secret, never any part of it, never the response body** — same rule
`handleProbe` follows.

It exercises the **capability**, not the handshake (B-16.2, now in CLAUDE.md).
Two worked examples, both real:

- **p5-25**: `searchPosts` 403'd *with* a valid session. It was a CDN block on
  `public.api.bsky.app`; `api.bsky.app` answers anonymously. The lane was one
  decision away from being parked over a hostname.
- **`GH_BILLING_TOKEN`**: valid token, `410 Gone` on a retired route.

Current state: all three ACCEPTED.

---

## 7. Purge doc

`docs/verification/2026-08-08-github-purge-ticket.md` carries the repo, the
pre-rewrite commit `cdd2ad36c1284da113b56378b00224fcaba79a9f`, and three blob
SHAs with byte counts, each confirmed still fetchable when written.

`docs/DATA_USE_POLICY.md` now carries the **open** purge item explicitly.
**Our attributed-redistribution commitment is not met until those blobs are
gone.** Record the closure there when Support confirms AND a direct-SHA fetch
returns 404. Both conditions, not one.

---

## 8. Four things most likely to trip you

1. **`CLAUDE.md` has no guard and was emptied to 0 bytes on main** (D-91),
   losing all five non-negotiables and every engineering rule. Restored. It is
   append-only doctrine, but **"take the longer side" is the wrong rule and was
   corrected on 2026-08-08: resolve a CLAUDE.md conflict as a UNION.** When
   both restores existed, neither was a superset — #203 carried B-16.2's
   capability rule and none of p6-01's four, and the p6-02 restore carried the
   four and not B-16.2. Taking the longer side would have silently dropped one
   set. CLOSED by D-97: the check is built, it runs unconditionally in CI
   because the docs-only diet would otherwise skip it, and it fingerprints
   named rules so partial resolution fails too.
2. **Two sessions sharing one checkout share one HEAD.** Every `git checkout`
   switches the other session's branch mid-task. Use a worktree.
3. **`git add -A` sweeps the other session's untracked files.** It happened
   twice. Stage explicit paths.
4. **Ambient env makes tests lie.** D-6 depended on a gitignored `.dev.vars`;
   the Bluesky disabled-lane test inherited `BLUESKY_ENABLED=true` from
   `wrangler.toml`, polled live, inserted 121 rows, and reported it as a broken
   lane. **Construct the env a test asserts on.**

---

## 9. Owner items

Per B-16.6, exactly one remains across both sessions: **O-3, ten posts.**
`post_log` is empty. Everything else is closed or ruled.
