# Public-exposure response — B-05

Measured 2026-08-06, 19:25–19:35 UTC. The repo was created public on
2026-07-26 and was still public when this ran. Everything below is a
measurement or a command that was executed, not an assessment.

## 1. Secret scan (B-05.1)

`gitleaks 8.x`, full history, all refs.

```
gitleaks git --log-opts="--all"
410 commits scanned. ~11446347 bytes (11.45 MB) in 964ms
no leaks found
```

**Zero findings.** The 410 against `git rev-list --all --count` = 498 is not a
gap: 86 of those are merge commits, which carry no unique diff to scan
(410 + 86 = 496, and the two remaining are the scanner's own root/boundary
handling). A tree-wide `gitleaks dir` was run as the second instrument.

Tree scan returned exactly one hit, `.dev.vars`, and that file is the control
rather than the failure:

```
commits touching .dev.vars : 0
present in any tree ever   : 0
git check-ignore           : .gitignore:3:.dev.vars
```

`.dev.vars` has never been committed. The committed file is
`.dev.vars.example`, which carries key names and no values.

A targeted pass for the token shapes this project actually uses (Telegram
bot-token `\d{8,10}:AA[\w-]{30,}`) across every commit: **0 hits**.

### What this means

No credential has ever been in this repository. The public window exposed
**code and documentation**, not secrets. Rotation below is therefore
precautionary, done because the price is near zero, not because a value
leaked.

## 2. Rotation (B-05.1)

Rotated, both sides, one sitting, 52 chars of `openssl rand` each:

| Secret | Worker | GitHub Actions | Live proof |
|---|---|---|---|
| `INGEST_SECRET` | set 19:31 | set 19:30:18Z | new→`400 bad request`, old→`401`, none→`401` |
| `ADMIN_PROBE_TOKEN` | set 19:31 | n/a (Worker only) | new→`200`, wrong→`401` |

Proof is against the deployed Worker at
`https://skeptic-persona.sahilsapra391.workers.dev`, not against local state.
The `400` on `/ingest` is the point: auth passed and the body was rejected,
which a `401` could not distinguish.

### Owner-only, cannot be rotated from a session

`TELEGRAM_BOT_TOKEN` (BotFather), `TELEGRAM_WEBHOOK_SECRET` (needs the bot
token to re-register via `setWebhook`), `OPENROUTER_API_KEY`,
`BLUESKY_APP_PASSWORD`, `THREADS_APP_ID`/`THREADS_APP_SECRET` (parked).
None of them ever appeared in git, so none is known-exposed.

## 3. Content exposure inventory (B-05.2)

Every path ever added across all refs: **431 distinct**. By extension:

```
.ts 175   .md 78   .fixture 70   .sql 65   .json 17   .xml 11
.yml 4    .mjs 2   .py 2   .b64 2   (none) 2   .example 1  .mts 1  .toml 1
```

**The ten competitor JSON archives were never committed.** All 17 JSON files
ever added are `package.json`, `package-lock.json`, `tsconfig.json`, and 14
`test/fixtures/*.json`. The competitor corpus (33,682 posts) exists in this
repo only as *derived measurements* inside `docs/verification/`: counts,
category rankings, and zero-hit findings. No corpus rows, no post text.

Largest blobs ever committed, as the cross-check that no archive is hiding
under an innocent name:

```
475.0 KB  test/fixtures/openfigi-batch1.json.fixture
324.3 KB  test/fixtures/openfigi-batch2.json.fixture
243.8 KB  test/tmp-payloads.ts
108.8 KB  test/fixtures/ftc-competition.xml.fixture
104.9 KB  package-lock.json
```

### `test/tmp-payloads.ts` — the one item that needs an owner's eye

The D-12/D-35 scratch file swept in by `git add -A`. Added in `21a7bb5`,
removed in `adf011f`, **still reachable in history**. Contents:

```
sources                 : house_ptr 56, senate_ptr 4
distinct named people   : 39 (sitting members of Congress)
SSN / address / email / phone / account-number / DOB : 0 of each
credential-shaped terms : 0
```

This is **congressional periodic transaction report data**: member name, asset,
transaction type, date, and an amount band. It is disclosure that the House
Clerk and Senate eFD publish by statute, and it is the exact data this
pipeline is built to republish. It is not a credential leak and not a
private-personal-data leak.

Where it is not clean: `docs/DATA_USE_POLICY.md` commits this desk to
redistributing that data **with attribution**, and a raw payload dump in a
scratch file carries none. That is a policy gap, not a legal breach, and the
call on whether to purge it from history belongs to the owner. Flagged, not
decided.

### OpenFIGI fixtures — resolved against primary terms (B-06.3)

**Source:** <https://www.openfigi.com/docs/terms-of-service>, "Last Updated:
November 27, 2018", fetched 2026-08-06 with the declared UA.

The terms draw a line, and our fixtures sat on the wrong side of it.

**Clause 1, Public Domain Dedication**, is scoped to a defined term:

> "Bloomberg hereby dedicates FIGI Identifiers to the public domain and makes
> FIGI Identifiers available to the public at large for free"

> "'FIGI Identifier' or 'FIGI' means a unique string of alphanumeric characters
> that designate a specific security or other financial instrument."

> "FIGI Identifiers may be freely reproduced, distributed, transmitted, used,
> modified, built upon, or otherwise exploited by anyone for any purpose,
> commercial or non-commercial"

**Clause 3, Disclaimer**, introduces a *second* category and never grants
anything for it:

> "THE DESCRIPTIONS OF THE ASSOCIATED SECURITIES AND FINANCIAL INSTRUMENTS
> PROVIDED BY BLOOMBERG IN DATABASES OR COMPILATIONS OF FIGI IDENTIFIERS
> ('RELATED SECURITY DESCRIPTIONS')"

Clause 3 is a warranty disclaimer. It says both categories are provided "AS
IS". It is not a licence.

So: the identifiers (`figi`, `compositeFIGI`, `shareClassFIGI`) are public
domain and could be stored freely. The descriptive metadata (`name`, `ticker`,
`exchCode`, `securityType`, `securityType2`, `marketSector`,
`securityDescription`) is **Related Security Descriptions**, and the terms are
silent on redistributing it. Silence is not permission, and B-06.3 says no
claim of clearance without a citation. There is no citation to make.

Separately confirmed by inspection, and it matters: **the responses contain no
CUSIP, ISIN or SEDOL.** OpenFIGI does not return third-party proprietary
identifiers; CUSIPs appear only in our *request*. So the licensing-sensitive
identifier was never in the cached bytes.

**Action taken** (B-06.3's conservative branch): the verbatim response bodies
are deleted and the fixtures are projected to the three fields
`src/lib/figi.ts` actually reads, confirmed by grep as `ticker` (25 refs),
`name` (16), `exchCode` (5), and nothing else.

```
openfigi-batch1.json.fixture   475.0 KB -> 106.1 KB   (77.7% removed)
openfigi-batch2.json.fixture   324.3 KB ->  75.1 KB   (76.8% removed)
job slots 10 -> 10, rows 1710 -> 1710 and 1278 -> 1278
remaining fields: exchCode, name, ticker
```

Row count and ordering are preserved deliberately, because two tests assert on
the *shape* of a live response and would lose their evidence otherwise: FIRST
HORIZON's US listing sits at position 6 behind five German venues, and EXXON
returns eleven entries with zero `exchCode US`. Those are what prove the
"never emit a foreign ticker" rule, which is a fabrication guard. 34 tests
pass after the projection.

The honest residue: 181 KB of `ticker`/`name`/`exchCode` is still Bloomberg
metadata. Keeping it is a judgement that a working mapping for 20 CUSIPs is
not the same act as redistributing a 2,988-row compilation, and that the
fabrication guard is worth more than the last 181 KB. Stated so it can be
overruled rather than buried.

## 4. Workflow trigger audit (B-05.3)

Across all three workflows:

```
pull_request_target : NONE
workflow_run        : NONE
issue_comment       : NONE
```

The structural result matters more than the settings: **`ci.yml` is the only
workflow reachable from a `pull_request` event, and it references zero
secrets.** The two workflows that hold `INGEST_SECRET`/`WORKER_URL`
(`ingest-relay`, `thirteenf-backfill`) are `schedule` + `workflow_dispatch`
only, and a fork cannot trigger either. Fork PRs get zero secret access by
trigger shape, before any policy is applied.

Settings, now permanent:

| Setting | Before | After |
|---|---|---|
| fork-PR approval | `first_time_contributors` | **`all_external_contributors`** |
| default workflow token | `read` | `read` (unchanged, already least-privilege) |
| workflow can approve PRs | `false` | `false` |
| `enforce_admins` on `main` | `true` | `true` |
| force pushes / deletions | disabled | disabled |

The fork-PR change is one notch stricter than B-05.3 asked for. There are zero
external contributors, so it costs nothing; dial back to
`first_time_contributors` if that is wrong.

Not done, deliberately: `sha_pinning_required` is `false`. Turning it on is
real supply-chain hardening, and it requires editing every `uses:` line in the
courier workflows. B-04.2 exempts the courier from change while it is the
live data path, so this is recorded as a follow-up rather than taken now.

## 5. Exposure snapshot (B-05.4)

GitHub traffic API, 14-day window. The repo is 11 days old, so this window
covers its whole public life.

```
visibility : PUBLIC      forks : 0      stars : 0      watchers : 0
clones : 655 total / 13 unique
views  : 366 total /  1 unique
```

Daily clones: 07-26 `5`, 07-27 `72`, 07-28 `80`, 08-01 `221`, 08-02 `210`,
08-03 `1`, 08-04 `9`, 08-05 `57` (13 unique — the only day with more than 2).

### Reading it

**One unique viewer, across the entire public life of the repo.** That
viewer is the owner. Nobody found this repository through GitHub's surface:
no fork, no star, no watcher, and no second human ever loaded the page.

Clone volume tracks CI, not discovery. The 221/210 spikes on 08-01 and 08-02
are the heaviest merge days, and every Actions run performs a checkout that
counts as a clone from an ephemeral runner identity. Clones without views is
the signature of automation; a human clones what they first looked at.

The 13 uniques on 08-05 is the one number that does not obviously fall out of
that, and it coincides with the day several chunks merged inside one hour
plus the 13F backfill. It is consistent with runner churn and is **not
evidence of a third party**, but it is also not proof of absence, and the
traffic API gives identities no finer than a count.

Honest bound: this data can show that nothing was *discovered*. It cannot
prove nothing was *cloned* by someone who found the URL another way.

## 6a. History purge — proven on a throwaway, ready to fire (B-06.2)

B-06.2's "verify no other test fixture carries the same shape" was answered by
scanning **every blob in history**, not a candidate list. All 430 blobs, for
PTR amount-band patterns (`$X,XXX - $Y,YYY`) co-occurring with a name field:

```
test/tmp-payloads.ts   1217 bands, 64 name fields
(everything else)      none
```

Three other files matched a looser field-name probe
(`ragValidate.test.ts`, `templates.test.ts`, `zzcoverage.probe.test.ts`) and
were cleared by inspection: they carry the *field names* `member`/`factLine`/
`tradeLine` in synthetic test rows, and **zero** real member names.

The purge was rehearsed on a `--mirror` clone rather than the live repo:

```
git filter-repo --force --strip-blobs-bigger-than 200K
```

That threshold is not arbitrary. Exactly three blobs in the entire history
exceed 200K, and they are exactly the three files at issue:

```
475.0 KB  test/fixtures/openfigi-batch1.json.fixture   (verbatim, pre-projection)
324.3 KB  test/fixtures/openfigi-batch2.json.fixture   (verbatim, pre-projection)
243.8 KB  test/tmp-payloads.ts                         (39 members' PTR rows)
```

The projected fixtures (106 KB / 75 KB) sit under the threshold and survive.
One pass therefore satisfies B-06.2 and the history half of B-06.3 together.

Rehearsal result on the throwaway:

```
tmp-payloads objects remaining : 0
files still carrying PTR rows  : NONE  (429 blobs re-scanned)
main tree hash   before/after  : 66a6090… / 66a6090…   IDENTICAL
main commit count before/after : 269 / 269
PR branch trees (x3)           : IDENTICAL
```

No content is lost from any branch tip. Nothing on `main` is pruned.

### Why it is not fired yet

Not a stall, a sequencing constraint, and B-06.2 named it ("coordinate the
rewrite with the visibility flip so it happens once"):

1. **Rewriting history does not evict anything from GitHub by itself.** Old
   objects stay reachable by direct SHA until GitHub garbage-collects, and
   GitHub's guidance is to contact Support to drop cached views. Firing while
   the repo is still public buys close to nothing.
2. **Force-pushing needs branch protection lifted** (`allow_force_pushes:
   false`, `enforce_admins: true`), which is a window worth keeping short and
   supervised.
3. **Three PRs are open** (#175, #177, #178). Merging them first means one
   rewrite instead of a rewrite plus three rebases.

Fires on the owner's "private is done" signal, ideally after the stacked PRs
merge on runner return.

## 6b. Error-swallowing audit (B-06.4)

The rule is now in `CLAUDE.md` beside D-48. The audit for other places a pipe
could hide a failure found **no second instance of the D-56 pattern**, and two
things worth stating rather than silently clearing:

- 20 occurrences of `.catch(() => {})` in `src/`. These are **not** the same
  bug: every one sits inside a `catch` block on a best-effort recovery write
  (`putSourceState`, `recordSourceError`, `markUnhealthy`), where the original
  error is already captured in the message being written. A failed health-write
  must not mask the failure it is reporting. Deliberate, left alone.
- `.github/workflows/ingest-relay.yml:232` ends the Senate uuid extraction with
  `|| true`, so a drifted `grep` pattern yields an empty `uuids.txt` and the
  job continues to build an empty bundle. That is the D-48 soft-failure class
  and it is on the live data path. **Not changed here**: B-04.2 exempts the
  courier while it is the data path, and D-48 requires a live dispatch run to
  verify any courier edit, which runners cannot currently provide. Queued
  behind D-55.

## 7. Not done, awaiting the owner's explicit line (B-05.6)

Secret scanning with push protection, Dependabot, the private ops repo, the
adversarial-source review pass, and `docs/PUBLIC.md` are all **untouched**.
B-05.6 gates them on an explicit stay-public ruling, and B-05.5's default is
revert. Nothing here presumes which way that goes.
