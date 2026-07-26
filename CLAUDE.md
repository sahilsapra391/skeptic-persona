# CLAUDE.md — skeptic-persona (Skeptic Wire)

Automated market-intelligence account on **Threads** (not X; pivoted 2026-07-26),
run by a Cloudflare Workers pipeline. Persona and archetypes live in the format
guide; architecture in the build plan (both in ~/Downloads, distilled into
docs/ here as needed).

## Non-negotiables (outrank everything, including speed)

1. **No fabrication.** Every number in every post comes from a field an
   ingester actually parsed. If a field didn't parse, the post doesn't claim
   it. Every post carries its source link.
2. **Primary sources only.** Filed, printed, or released by an official
   source, or parsed from our own data lake. No "reportedly."
3. **No vendor-data republishing.**
4. **Honest automation.** Bio discloses the account is Skeptic's automated
   wire. No fake typos, no engagement bait. Template rotation is also a
   Meta-policy requirement (repetitive content is a named spam signal).
5. **No advice language.**

## Engineering discipline

- One chunk per PR. Plan before code. Tests with every chunk. Code review
  before done. Secrets env-only; every PR description lists new env vars.
- **Endpoint verification is law:** never trust a remembered URL. Every
  feed/API endpoint gets live-verified during its chunk; the PR notes what
  was verified and when. Records live in docs/verification/.
- Zero runtime npm dependencies in the Worker (free-tier CPU is 10 ms per
  invocation; parsing is regex-first on hot paths). Dev deps are fine.
- Dedup state lives in **D1** (`items.dedup_key` UNIQUE + INSERT OR IGNORE),
  not KV — KV free tier allows only 1k writes/day. KV holds only low-write
  state: template rotation, autonomy counters, kill switch.
- One cron trigger total (`* * * * *`); everything else is the D1 `jobs`
  table + the dispatcher. Cloudflare free plan allows 5 crons per ACCOUNT.
- All times stored as ISO-8601 UTC. Feed timestamps arrive in four different
  conventions (ET-offset, UTC-Zulu, ET-naive, date-only) — normalize at parse.

## Platform facts (verified 2026-07-26, see docs/verification/)

- Threads API: free, 250 posts + 1,000 replies per rolling 24 h per profile.
  Long-lived tokens die at 60 days — the weekly refresh job is load-bearing.
  Invalid token = HTTP 500 with JSON `error.code` 190 (never trust status
  class alone). `link_attachment` carries the source URL outside the 500-char
  text limit (TEXT posts only).
- SEC: declared User-Agent mandatory, ≤10 req/s, content-type headers lie.
- BLS: 403s default UAs; no cache headers on release pages (content-diff).

## Voice

Post templates follow the persona guide (wire-terse, attribution always),
NOT Sahil's personal LinkedIn voice rules. The persona doc gets its own file
in P2; Sahil signs off on voice.
