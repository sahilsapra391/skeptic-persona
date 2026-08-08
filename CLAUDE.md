# CLAUDE.md — skeptic-persona (Skeptic Wire)

Automated market-intelligence account on **X** (@SkepticTrades), run by a
Cloudflare Workers pipeline. Ingestion, scoring and the Telegram approval queue
are automated; **publishing is manual** — the pipeline hands the owner
copy-ready commentary and he posts it. Persona and archetypes live in the
format guide; architecture in the build plan (both in ~/Downloads, distilled
into docs/ here as needed). Current track: [docs/p2r-plan.md](docs/p2r-plan.md).

> Platform history: X (planned) → Threads (2026-07-26, X free tier was
> withdrawn) → X manual (2026-07-28, Meta banned the Threads account on
> suspected bot activity). The Threads client is parked, not deleted:
> [docs/verification/2026-07-28-threads-ban.md](docs/verification/2026-07-28-threads-ban.md).

## Non-negotiables (outrank everything, including speed)

1. **No fabrication.** Every number in every post comes from a field an
   ingester actually parsed. If a field didn't parse, the post doesn't claim
   it. Every post carries its source link.
2. **Primary sources only.** Filed, printed, or released by an official
   source, or parsed from our own data lake. No "reportedly."
3. **No vendor-data republishing.**
4. **Honest identity** (amended 2026-07-27, owner-approved). The account is
   Skeptic's market desk: brand-affiliation transparent (skeptic.fyi
   visible), never a fake human (no invented name, avatar, or lore), and it
   never denies automation if asked (true answer: "Skeptic's desk, a human
   runs it"). No fake typos, no engagement bait. Rotation and shape variety
   stay mandatory: repetitive content is a named spam signal on every platform
   and is the most plausible cause of the Threads ban.
5. **No advice language.**

## Relay protocol (B-01.1, adopted 2026-08-06)

Owner instruction blocks carry IDs (`B-01.4`, `B-01.10`). **Acknowledge every
numbered item by ID** with one of `applied` / `new-built` / `conflict`.
Anything unacknowledged gets resent, so silence costs the owner a round trip.
`conflict` is a legitimate answer and is expected when an item contradicts
signed doctrine — say so, cite the lines, and wait for the ruling rather than
resolving it quietly.

## Engineering discipline

- One chunk per PR. Plan before code. Tests with every chunk. Code review
  before done. Secrets env-only; every PR description lists new env vars.
- **Workflow and courier changes require one live dispatch run before merge.**
  Reading the YAML is not verification (D-48). Earned twice in one hour: a
  soft-skip that left the next step to die on a missing file, and its fix
  applied to the wrong job's step.
- **Redact a command's input, never filter its error output** (D-56). Piping
  `wrangler secret put` through a `grep -v secret` to avoid echoing values ate
  the line saying the write had FAILED, and the call read as success. If a
  command takes a secret, hide it on the way in (stdin, env, a file), and let
  stderr through untouched.
- **A secret or config write is not applied until it is proven against the
  deployed target** (D-56). Not against local state, not against an exit code,
  not against the absence of an error message. `INGEST_SECRET` rotated on
  GitHub and silently failed on the Worker, because `wrangler secret put`
  refuses when the newest version is not the deployed one and Workers Builds
  uploads a version per PR build. The half-state was invisible precisely
  because the courier was already down: it would have detonated on recovery.
  Prove it with a live call that can tell auth-passed from auth-failed (a
  `400` on a junk body, not just "no 401").
- **Verify the CAPABILITY the lane depends on, not merely that the credential
  authenticates** (D-56 sharpened, B-16.2). A working session that 403s on the
  only endpoint a lane needs is a working credential and a dead lane, and the
  two are indistinguishable if you stop at the login.
  *Worked example, p5-25.* The Bluesky lane was recorded as "search requires
  auth" because `searchPosts` returned 403 — and it did, on
  `public.api.bsky.app`. The owner then supplied the credential, the lane
  authenticated cleanly, and search **still** 403'd, which read as
  confirmation that credentials could not fix it and nearly parked the lane.
  The 403 was a CDN block on one host: `api.bsky.app` answers the same call
  anonymously with real results. A capability check would have caught it
  before the credential was ever requested.
  Same shape on `GH_BILLING_TOKEN`: a valid token, and
  `/users/{u}/settings/billing/actions` returned **410 Gone** because GitHub
  retired the route. Valid credential, dead capability, again.
  So: **where a credential gates a specific capability, `/admin/credcheck`
  exercises that capability**, not just the handshake. It creates the Bluesky
  session *and runs a search*; it reads NASS *counts*; it reads GitHub *runs*.
  Anything less is a green light on a lane that cannot work.
- **A verification that cites agreeing examples is not a verification**
  (D-89, B-12.2). Ground truth has to be an INDEPENDENT AUTHORITY, not a
  larger sample of the same source. p6-01 asserted Form 144's
  `nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold` follows EDGAR's
  `LAST FIRST` convention, citing two live filings that did. Both real, both
  picked because they agreed. The field is free text typed by the filer
  agent, and against EDGAR's own conformed name per CIK it disagreed in 25 of
  87 comparable filings the same day. **CIK 0001514725 filed a Form 144
  (`KENDRA D MILLER`) and a Form 4 (`Miller Kendra D`) on 2026-08-07**, and
  the pipeline rendered `D. Miller Kendra` and `Kendra D. Miller` for one
  person, on two cards, each linking to the filing that contradicted it.
  Scaling the sample 49 -> 115 names had already caught five defects and
  still missed this, because every name in both came from the same place.
  Name the authority you checked against, and report the disagreement rate.
- **A silent selection over a one-to-many source is a coin flip, not a
  lookup** (D-93, B-17.2). It does not produce broken data, it produces
  PLAUSIBLE data, which is why it survives review. `issuers` is keyed on
  `cik` while SEC's ticker file lists 10,398 rows over 7,999 CIKs, so
  `ON CONFLICT(cik) DO UPDATE` took whichever row came last. **JPMorgan Chase
  resolved to `$VYLD`** -- unsuffixed, undashed, right exchange, entirely
  wrong -- alongside BANK OF AMERICA at `MER-PK` and MORGAN STANLEY at
  `MS-PQ`. Nothing about `$VYLD` looks wrong to a validator, and 247 rows sat
  like that in production. When a write is keyed on something the source does
  not key on, make the choice EXPLICIT, deterministic and recorded.
- **Row-count agreement is weak evidence; check the quantity that has to be
  conserved** (D-94, B-17.2). `holdings_13f` has the identical upsert shape,
  and filing 301 declared 90 rows while storing 29, which reads as silent
  loss. It is not: `parseInfotable` aggregates on the same key before the
  write. **The tell was that parsed and stored VALUE totals matched to the
  dollar** -- rows may legitimately merge, money may not vanish. Withdraw a
  finding the moment the conserved quantity clears it.
- **A doc change is not applied until it is in the COMMIT** (D-95). Twice in
  this program I reported a doc item done that was never in the diff, and the
  second time I destroyed the file doing it: `open(f,'w').write(open(f).read()
  .replace(...))` truncates on the FIRST open, so the read returns empty and
  the write stores nothing. It emptied this file, `git add -A` staged it, and
  it merged in #201. **Never write a file in the same expression that reads
  it.** Read into a variable first, and verify a doc item with
  `git show <sha> --stat` before reporting it done -- a `--stat | tail -n`
  that hides the alphabetically-first path is how this stayed invisible.
- **A safeguard whose blind spot aligns with its target is worse than none**
  (D-99, B-19.1), because it also produces confidence. Three instances so far:
  a validator that passed 8-for-8 only because an unrelated payload field
  carried the same token; a `grep -v` redacting a command's stderr that
  swallowed the line saying the write had FAILED (D-56); and a governance test
  skipped by the docs-only CI classifier on exactly the PRs that can empty
  governance files (D-96). **When you build a check, state what change it is
  meant to catch and prove the check RUNS on that change** — not merely that
  it passes on a normal one. The proof is running the check against the
  failure it exists for, and watching it fail.
- **A check's reporting layer must be incapable of printing a clean result
  when the check failed** (D-102, B-20.2). Third instance this week, and all
  three are the reporting layer rather than the check: a `grep -v` over
  `wrangler`'s stderr that removed the line saying the write had FAILED
  (D-56); `git show --stat | tail -12`, which hid the one path that mattered
  because `CLAUDE.md` sorts first among thirteen; and `uniq -d` followed by an
  unconditional `echo "(empty=none)"`, which printed reassurance directly
  underneath the duplicates it had just found. **General form: any summary
  line that can render identically on success and failure is a defect in the
  check, not in the reader.** Make the success message derive from the same
  value the failure branch reads.
- **On a conflict in a rule or doctrine file, ENUMERATE first, then choose the
  operation** (D-100, amended B-20.1). Applies to `CLAUDE.md`,
  `docs/p5-ledger.md`, `docs/EXCLUSIONS.md` and `docs/DATA_USE_POLICY.md`.
  List what each side uniquely holds BEFORE resolving; that list tells you
  which of three cases you are in.
  1. **Genuinely divergent content — union.** The default, and the only case
     union fits. After the CLAUDE.md truncation two restores existed and
     NEITHER was a superset: [#203] carried B-16.2's capability rule and none
     of p6-01's four, the p6-02 restore carried the four and not B-16.2.
     "Take the longer side" drops a rule set either way, silently.
  2. **Same content under different identifiers — the canonical side wins,
     and union DUPLICATES.** Rebasing p6-02 onto #206 produced a hunk whose
     two sides held zero unique rules and differed only in D-number: main had
     the final D-93/94/95, the branch the pre-renumber D-91/92/93. Unioning
     there would have written every rule twice under two ids.
  3. **Superseded work — no-op.** The same rebase replayed a guard commit that
     #206 had already landed in a better form. It collapses; nothing to merge.
  Union is the default for (1) ONLY. The enumeration is what tells you whether
  union is even the right operation, and skipping it is how the ledger grew
  six rows for three defects.
- **A renumbering keys on ORIGINAL values, in a single pass** (D-101). Never
  apply mappings iteratively: `D-92->93, D-93->94, D-94->95` run as a loop
  over every row rewrites the same row three times and collapses all of them
  onto the last number. This is written down because it was warned about in a
  comment two commits before it happened. The duplicate-id check in
  `scripts/check-governance.mjs` is what caught it and is permanent.
- **An empty result must be provably empty, and every number carries its
  as-of** (D-104 / D-105, B-23.5). Two distinct failures, both of which
  reported a desk that had published nothing while `post_log` held 34 rows.
  **Schema:** a query selecting `created_at` from a table whose column is
  `posted_at` returns nothing, and a zero that means "asked wrongly" is
  indistinguishable from one that means "nothing is there". Validate any zero
  used to justify a decision against the schema and against an independent
  non-empty count before reporting it. **Staleness:** the p5-ledger's
  manual-post counter of `4` was CORRECT when measured on 2026-08-06 and wrong
  from the moment it was quoted afterwards — the same query returns 16.
  A number quoted without its as-of is an assertion about now made from a
  measurement of then, so re-derive before reuse. The live instance: the
  digest printed "Nothing has been published from this window. The Copy button
  is the constraint" off a WINDOWED zero, phrased as a claim about the desk;
  it now reports the all-time count alongside, so a quiet week and an empty
  table can never render the same sentence.
- **A digest sentence that makes a claim about the WORLD must name its window
  and carry its independent all-time count** (D-106, B-24.3). Reporting a
  metric and asserting a fact are different acts, and generated prose is read
  as a finding. `renderNorthStar` printed "Nothing has been published from
  this window. The Copy button is the constraint, not the queue." — the first
  clause names its window, the second diagnoses the whole program and names
  none. Three sessions read it, repeated it into every status report, and it
  set priority for a week while `post_log` held 16 manual posts. The class is
  not "wrong number", it is **generated prose treated as a finding**. If a
  line diagnoses rather than counts, it needs the denominator that would
  falsify it in the same breath.
- **A gate written into a dated document cannot know when it has been met**
  (D-108, B-25.1), so its freeze outlives its condition. `handoff-ingestion-
  2026-08-02.md` stopped all source work "until 10 manual posts are recorded";
  the count passed 10 on 2026-08-06 and the stop still read as active two days
  later. Eleven ledger rows still said `blocked-gate` on the same counter
  while six of those lanes had already shipped. **Any conditional freeze lives
  in a LIVE CHECK with a named owner and a re-evaluation trigger, or it does
  not exist.** A dated doc may record that a gate existed and was met; it may
  never enforce one. When you write "resumes when X", say who re-evaluates X
  and what makes them look.
- **A digest may report what it measured in its window; it may not diagnose
  why** (D-106, sharpened B-25.3). The defect is a windowed observation
  followed by an UNWINDOWED CAUSE: "Nothing has been published from this
  window" is a measurement, "The Copy button is the constraint, not the queue"
  is a program-level causal claim, and the template is not entitled to make
  one. Causal claims about the program belong to the owner, not to generated
  prose.
- **A status column that disagrees with the repo is worse than no status
  column** (D-109, B-26.2), because it reads as fact rather than as stale.
  Eleven ledger rows said `blocked-gate` while six of those lanes had shipped.
  **Anything derivable from repo or production state must be DERIVED, not
  hand-maintained.** Derivable today and now checked: whether a cited
  verification doc exists (`scripts/check-governance.mjs`). Derivable but
  needing the network, so reported rather than gated: whether a cited PR is
  merged, and therefore whether `merged-verified` is true. NOT derivable and
  correctly hand-written: scope, `blocked-owner`, `parked(reason)` — those are
  judgements, and a judgement is the only thing a status column should hold.
- **Determinism without an authority is a consistent wrong answer** (D-113,
  B-28.1). Replacing a nondeterministic selection with a deterministic one
  does not make it correct. The `issuers` upsert was a coin flip (D-93); the
  fix was "shortest symbol, then alphabetical", which is perfectly repeatable
  and picks **`$CCZ` for Comcast** — its own 10-K cover calls CCZ the "2.0%
  Exchangeable Subordinated Debentures due 2029". SEC's ticker file carries no
  security TYPE, so no rule over that file can separate a common share from a
  listed debenture, and the rule passed its AT&T test only because AT&T's
  common share happens to be the shortest symbol. **When the source cannot
  answer the question, report the ambiguity; do not resolve it consistently.**
- **A metric computed with the artifact it is meant to validate cannot
  validate it** (D-99 sharpened, B-28.2). The share-class regex was
  `/^[A-Z]$/`, which counts a bare `-P` as a class letter — and the header's
  "29 single-letter share classes" figure, offered as evidence the regex was
  right, was computed WITH that regex, so the five preferred symbols it
  wrongly admitted were counted into the bucket that hid them. Measure with an
  independent instrument or the measurement is a restatement.
- **A measurement over prose cannot measure a field** (D-102 sharpened,
  B-28.2). "20 stored payloads carrying dashed tickers" came from a `LIKE`
  over whole payload TEXT and was matching narrative. Queried against the
  actual ticker field it is 7, all legitimate share classes, and zero bad
  symbols are stored anywhere. Query the field, not the blob.
- **Adversarial review is REQUIRED, not optional, on any chunk touching
  validators, resolution, or copy** (B-28.7). Two chunks, fourteen confirmed
  defects, and a green suite caught none of them: p6-01 shipped a name
  normalizer that invented people, p6-02 a resolver that named a debenture as
  a company's stock. Both suites passed throughout. The review runs before
  merge, adversarially (try to REFUTE each finding), and against live primary
  sources rather than fixtures.
- **A validation belongs where the value is CREATED, not at the call site you
  were reading** (D-117, B-29.1). If a value can reach copy by more than one
  path, guarding one path is not a guard. `tickerTag()` was a bare template
  literal and every caller was trusted: of eight call sites, **six passed
  unvalidated external input** — Nasdaq's threshold file, the halts feed,
  symbols parsed out of congressional disclosure PDFs, openFIGI, and the
  issuers table. `form4` was merely the one that got caught, because Greif
  files `issuerTradingSymbol` as `"GEF, GEF-B"` and that lane is the
  highest-volume one at 18/18 on cashtags. Fixing `form4`'s parse fixed
  `form4` and nothing else. **Before shipping a validator, list every path its
  value can take to copy and put the guard upstream of all of them.**
- **Test the bug, not the environment** (D-116 generalized, B-29.3). For a
  defect that only manifests under conditions the test runner does not
  reproduce, ENCODE THE OLD MECHANISM and assert the new code disagrees with
  it. `Date.parse` local-midnight was invisible because CI and workerd both
  run UTC; rather than demanding a non-UTC runner, the test computes what the
  old path would produce at +60/+120/+330/+480/+540 minutes and asserts the
  component parser differs. This is stronger than depending on a runner's
  configuration, which can silently change.
- **Endpoint verification is law:** never trust a remembered URL. Every
  feed/API endpoint gets live-verified during its chunk; the PR notes what
  was verified and when. Records live in docs/verification/.
- Zero runtime npm dependencies in the Worker; parsing is regex-first on hot
  paths. (The account moved to Workers Paid 2026-07-27 when free-tier 10 ms
  CPU killed the first posts — the discipline stays, the budget math is
  against paid-plan limits now.) Dev deps are fine.
- Dedup state lives in **D1** (`items.dedup_key` UNIQUE + INSERT OR IGNORE),
  not KV — KV free tier allows only 1k writes/day. KV holds only low-write
  state: template rotation, autonomy counters, kill switch.
- One cron trigger total (`* * * * *`); everything else is the D1 `jobs`
  table + the dispatcher. Cloudflare free plan allows 5 crons per ACCOUNT.
- All times stored as ISO-8601 UTC. Feed timestamps arrive in four different
  conventions (ET-offset, UTC-Zulu, ET-naive, date-only) — normalize at parse.

## Platform facts

### X (verified 2026-07-28, see docs/verification/2026-07-28-x-post-length.md)

- Posts are measured by **weighted** length, not `String.length`, and the naive
  measure is wrong in BOTH directions. Sum a weight per code point and divide
  by 100: code points in `[0,4351] [8192,8205] [8208,8223] [8242,8247]` weigh
  100, everything else weighs 200. Emoji count as one cluster at 200 (a country
  flag is 2 to X and 4 to JS); CJK is 2 (`日` is 1 to JS). Limit 280 free.
- Any URL is billed at exactly 23 via t.co, whatever its real length.
- `developer.x.com/en/docs/counting-characters` returns HTTP 402 to an
  unauthenticated fetch. The usable primary source is twitter-text config v3.
- No API (manual posting), so no token, no quota endpoint, and no automated
  publish path to defend. The source link rides in a reply rather than the post
  body — a product decision about link deprioritisation, not a verified fact.

### Verified 2026-07-26, see docs/verification/

- Threads API (PARKED 2026-07-28, account banned): free, 250 posts + 1,000
  replies per rolling 24 h. Long-lived tokens die at 60 days. Invalid token =
  HTTP 500 with JSON `error.code` 190; a ban shows up as `code 1`, so never
  trust status class alone and never trust code class alone either.
  `link_attachment` carried the source URL outside the 500-char text limit.
- SEC: declared User-Agent mandatory, ≤10 req/s, content-type headers lie.
- BLS: 403s default UAs; no cache headers on release pages (content-diff).
- Telegram: secret arrives in `X-Telegram-Bot-Api-Secret-Token`; non-2xx
  webhook responses trigger redelivery (dedupe on update_id EQUALITY);
  callback_data ≤64 bytes; text ≤4096 chars; NO parse_mode (MarkdownV2
  rejects unescaped `.`/`-`/`(` — every numeric draft would 400).

## Voice

**docs/persona.md is the signed-off voice authority** (owner pass applied
2026-07-27). Post templates follow it, NOT Sahil's personal LinkedIn voice
rules. Core structural law: fact first + attribution, ONE dry beat last,
never blended; beats are machine-gated to parsed fields; rotation is
mandatory. Any template/persona conflict is a bug in the template.
