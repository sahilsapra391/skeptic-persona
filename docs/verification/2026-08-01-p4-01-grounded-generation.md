# p4-01 — Grounded generation (2026-08-01)

Owner directive (2026-08-01, after reviewing the first valid generation):
variants read machine-made and take-free — "not just facts about it, but what
is going on in the world right now based on that... grounded in actual
worthwhile proven content." Owner re-sequenced grounding ahead of
salience/curation in the same session.

## What generation now sees (three universes, all proven)

1. **PAYLOAD** — unchanged, parsed fields only.
2. **SOURCE DOCUMENT** — `items.raw_text` (migration 0043), filled two ways:
   - at INGEST when the bytes are already in hand: press RSS `<description>`
     (tag-stripped, URL-scrubbed, 40–2,000 chars; boilerplate dropped) — the
     archetype that needed grounding most gets it for free, including through
     the relay lane;
   - at GENERATION for items without it: one conditional fetch through the
     same politeFetch stack every ingester uses (declared UA, 20s timeout),
     cached write-once on the item row — a document is fetched at most once,
     ever. Official-source hosts (closed suffix list: SEC, FDA, Fed, BLS,
     Treasury, Federal Register, NOAA, House/Senate, FTC/CFTC, FCA, EC and
     the central banks) enter in full capped at 24k chars (~6k tokens);
     anything else gets a 1,200-char excerpt (conservative default).
     Egress-blocked hosts (www.cftc.gov, efdsearch.senate.gov, both treasury
     hosts, NSE — the verified P1/P3 blocks) are refused BEFORE any fetch;
     a fetch-spy test pins that. Failures degrade to payload+context and
     never block generation. Provenance recorded in `items.raw_meta`
     ({host, fetchedAt, sha256, bytes, mode, truncated}).
3. **LAKE CONTEXT** — machine-derived lines from our own D1 lake
   (`rag/context.ts`): prior-item counts and the 1–2 most recent titles for
   the same actor (entity keys per archetype: authority, member, country,
   cik/ticker…), falling back to source-level, always carrying the observed
   window ("since <date>"). No superlatives — record/streak claims stay with
   the gated beats and their 90-day coverage floor. Rates need no special
   case: their payloads already carry priorValue/priorDate/changeBps.

URL scrub everywhere: grounding text feeds the URL-free prompt, so bare URLs
are stripped at capture and at fetch (`lib/html.ts scrubUrls`).

## Validator widening (same PR, per the audit's contradiction warning)

`groundingFacts(text)` parses the grounding with the SAME primitives and the
same closed bypasses as `payloadFacts`: dates structurally (phrase + ISO,
consumed so components never leak as free integers), numbers at parsed value
with scale-DOWN-only licensing, percents only from tokens the source itself
marks %/bps, spelled-out numbers at word value. `mergeFacts` unions the sets
and concatenates the entity/verbatim haystacks. Kill-tests prove the attacks
still die under grounding: 45,000-in-source never licenses "$45 billion";
plain source numbers never become percent claims; unstated dates and numbers
in neither universe still reject.

## Prompt

DATA gains the two blocks with provenance (host + timestamp, no URLs); the
whitelist rule names all three universes; the commentary spec now demands the
take engage THE SPECIFIC RECORD and bans market-reaction claims (spreads,
flows, pricing, positioning) unless stated in the data — the exact
unparsed-empirics class the owner flagged on cycle 30 ("Spreads compress
fast. Retail absorbs the shock.").

## Evidence

- Suite: 655 passing (+12), including live-shaped fixtures: full-host fetch
  with cache write-once proven via a second no-interceptor round; blocked
  host proven via fetch spy; excerpt cap; 404 degrade; press description
  extraction from crafted CDATA+HTML+URL feeds.
- Migration 0043 applied to remote D1 ahead of merge (additive; old code
  unaffected) — see PR.
- First live grounded generation: recorded below after the next real
  approval/regenerate on the deployed build.

## Live run (appended when observed)

PENDING — next approved or regenerated item on the post-merge deploy.
