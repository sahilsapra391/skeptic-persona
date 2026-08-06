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
