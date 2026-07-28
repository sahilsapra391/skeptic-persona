# Verification: regulator press feeds — 2026-07-28T02:32Z

## UK FCA — WORKING

`https://www.fca.org.uk/news/rss.xml` — **200, 65,682 bytes, 20 items.**

Carries a `<category>` per item with a clean live taxonomy: **Press Releases,
News stories, Blogs, Statements, Speeches**. That is the selection gate:
enforcement and statements reach the queue, blogs and speeches stay in the
lake.

Dates are a HUMAN format, not RFC-822: `Monday, July 27, 2026 - 15:30`.

## European Commission — WORKING, but not at any obvious URL

| URL | Result |
|---|---|
| `/commission/presscorner/api/rss?language=en&pagesize=20` | **200, valid RSS, 20 items** |
| `/commission/presscorner/home/en/rss.xml` | 200 — but the **SPA HTML shell** |
| `/commission/presscorner/detail/en/rss.xml` | 200 — SPA HTML shell |
| `/info/rss/news_en.xml` | 404 |
| `/commission/presscorner/api/documents?reference=IP&...` | 200 with an **empty body** |

Two of the wrong URLs return **HTTP 200 with an HTML page**, which a naive
"is it 200?" check would accept and a naive XML parse would silently reduce
to zero items. Only `/api/rss` returns real RSS.

Dates are RFC-822 (`Mon, 27 Jul 2026 09:20:41 GMT`), so the two sources in
this family need two date formats between them.

**"Daily News 27 / 07 / 2026"** is a weekday roundup of everything the
Commission published. It is a digest, not an event, and would take a queue
slot every single day, so it is filtered by title.

## Enforcement wire — verified 2026-07-28T04:02Z

| Source | URL | Result |
|---|---|---|
| SEC administrative proceedings | `/rss/litigation/admin.xml` | **200, 25 items** |
| CFTC enforcement | `/RSS/RSSENF/rssenf.xml` | 200 from residential, **403 from Worker egress — PARKED** |
| FTC competition | `/feeds/press-release-competition.xml` | **200, 30 items** |
| ~~SEC litigation releases~~ | `/rss/litigation/litreleases.xml` | **404** (serves an HTML page) |

The SEC litigation-releases feed is dead — 404 with an HTML body, so a
naive check that only tests for a non-empty response would accept it.
Administrative proceedings carry the same enforcement content and are live.

Live headlines at capture: "Hext Capital Partners LLC and Gregory W. Hext,
CPA" (SEC), "CFTC Charges North Carolina Commodity Pool Operator" (CFTC),
"FTC Secures Major Settlement with Caremark, Resolving Antitrust..." (FTC).

Enforcement is the highest-lift category measured across the five competitor
corpora (1.63x median engagement), and these are the actions themselves
rather than anyone's report of them.

**Three date offsets in one family:** SEC and FTC emit `-0400`, CFTC emits
`+0000`. All normalize to UTC at parse.

### CFTC press host blocks Workers (2026-07-28T04:08Z)

`www.cftc.gov` returns **403 to Cloudflare Worker egress** and **200 to the
identical declared UA from a residential connection**. SEC and FTC were
polled in the same tick from the same Worker and both returned 200, so this
is host-specific, not a client problem.

**CFTC positioning is unaffected.** Commitments of Traders lives on
`publicreporting.cftc.gov`, a different host that answers Workers fine — so
the same agency is half reachable.

Parked on the daily auto-recovering probe. Fifth egress failure mode on this
project after Senate eFD (403), NSE India (UA reset), and treasury.gov (TLS
525 + timeout).

## Doctrine

Neither feed carries a number. The `REGULATORY_NEWS` templates are therefore
**numberless by construction** — there is no slot a figure could occupy, so
they physically cannot emit one. This is the rule the source roadmap asked
for on prose-only sources, enforced structurally rather than by reviewer
discipline, and there is a test asserting the only permitted slot is a date.
