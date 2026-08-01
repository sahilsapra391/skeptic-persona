# Global wire fanout — 44 probed, 14 adopted

**Verified 2026-08-01T22:4xZ**, declared UA (`Skeptic Wire admin@spechawk.ai`).

Two gates, and the second is the one that mattered: a candidate had to return
**200**, and then parse to **three or more items through our own
`parsePressFeed`** — not merely through curl. Four feeds passed the first gate
and failed the second, which is exactly the "200 with the wrong shape" trap
this project keeps re-encountering.

## Adopted (8)

| Source | Authority | Items | Dialect |
|---|---|---|---|
| `press_doj` | DOJ | 25 | RSS 2.0 |
| `press_fed_speeches` | Federal Reserve | 15 | RSS 2.0, CDATA-wrapped |
| `press_ecb` | European Central Bank | 15 | RSS 2.0 |
| `press_boc` | Bank of Canada | 10 | **RSS 1.0 / RDF** |
| `press_ons` | UK ONS | 10 | RSS 2.0 |
| `press_ofsi` | UK OFSI | 10 | **Atom** |
| `press_rbi` | Reserve Bank of India | 10 | RSS 2.0 |
| `press_sebi` | SEBI | 30 | RSS 2.0, date-only stamps |

`press_rbi` and `press_sebi` are the desk's first coverage of India. NSE and
BSE stay parked — both hosts reset our declared UA (verified 2026-07-27) and
doctrine forbids disguising the client.

## Rejected (12), so nobody re-probes them

| Candidate | Result |
|---|---|
| `fdic.gov/news/press-releases/rss.xml` | 404 (HTML body) |
| `finra.org/rss/notices.xml` | 404 (HTML body) |
| `sec.gov/rss/litigation/litreleases.xml` | 404 — already documented dead |
| `cpsc.gov/.../Recalls` | 404 |
| `home.treasury.gov/.../ofac.xml` | 403 |
| `usda.gov/rss/latest-releases.xml` | 403 |
| `imf.org/en/News/RSS` | 403 |
| `eurostat/.../rss` | 404 |
| `occ.gov/rss/occ_enforcement_actions.xml` | 200, HTML, zero items |
| `worldbank.org/en/news/all?format=rss` | 200, HTML, zero items |
| `api.gdeltproject.org/.../doc` | 429 rate-limited — retry later, not dead |
| `press_cftc_enforcement` | already registered; host 403s Worker egress |

Six of the twelve return **HTML with a 404 or 200**, which is the same trap
recorded for the SEC litigation feed: a status check alone accepts some of
them, and a content-type check accepts others.

## The parser had to grow, and that is the real finding

Four adopted feeds parsed to **zero items** on first attempt despite the probe
counting items in the raw XML. Each for a different reason, and none of them
would have surfaced without running our own parser over a real capture:

| Feed | Cause |
|---|---|
| Fed speeches | `<link>` and `<pubDate>` wrapped in **CDATA**; only `<title>` was being unwrapped |
| Bank of Canada | **RSS 1.0/RDF** — the date is `<dc:date>`, not `<pubDate>` |
| OFSI | **Atom** — items are `<entry>`, and the URL is a `href` attribute on `<link rel="alternate">`, not a text node |
| SEBI | date-only stamps such as `31 Jul, 2026 +0530`, which `new Date()` rejects outright |

`parsePressFeed` now: falls back from `<item>` to `<entry>`; reads the date
from the first of `pubDate`, `dc:date`, `published`, `updated`; strips CDATA
from every field rather than just the title; takes the Atom `alternate` href
in preference to `self` or `replies`; and supplies midnight for a date-only
stamp rather than discarding a real filing over punctuation.

All six pre-existing press sources are unchanged — 760 tests green.

## Why this matters beyond these eight

The fanout the plan calls for will keep meeting these three dialects. Reading
only `<item>` and only `<pubDate>` is how a feed returns 200, visibly contains
items, and still yields nothing — with no error anywhere. Every adopted feed
above now ships a trimmed real capture as a fixture, so a future shape change
fails a test rather than silently emptying a source.

---

# Batch 2 — 24 more probed, 6 adopted

Same two gates. Twenty-four candidates, eight returned a usable feed, **six
survived our own parser**.

## Adopted (6)

| Source | Authority | Items |
|---|---|---|
| `press_sec_speeches` | SEC Commissioners | 25 |
| `press_cfpb` | CFPB | 20 |
| `press_gao` | GAO | 25 |
| `press_eba` | European Banking Authority | 10 |
| `press_boe_news` | Bank of England | 50 |
| `press_riksbank` | Sveriges Riksbank | 10 |

Press sources now total **20**.

## ESMA: usable feed, refused anyway

`esma.europa.eu/rss.xml` returned 200 with ten items and looked adoptable.
Its `<item>` blocks contain **only** `description`, `link` and `title` — no
`pubDate`, no `dc:date`, no `published`, no `updated`.

The tempting fix is to date the item by fetch time. That would make every
item look fresh, so a month-old release would post as news — claiming a date
we do not have. **Refusing the source is the cheaper error**, and a test pins
that a dateless feed parses to nothing.

This is the third distinct way a feed has looked adoptable and not been: wrong
content (OFAC's programme list), wrong dialect (BoC, OFSI), and now missing a
field the doctrine requires.

## GDELT: usable, deferred

The 429 in batch 1 was transient — it returns 10 articles on retry. But it is
**JSON, not RSS**, so it needs its own parser rather than a row in
`PRESS_SOURCES`. Deferred to its own chunk rather than bolted on.

## Rejected (17 across both batches)

Batch 2 adds: FDIC and FINRA (404 on both alternate paths tried), NHTSA (403),
USPTO (404), Bundesbank (404), Banque de France (403), Norges news (404),
HKMA (404), ASIC (404), BoJ statements (404), Banxico (404), MAS Singapore
(200, 854KB of HTML, zero items), OCC (200, HTML, zero items), Banco Central
do Brasil (200, HTML, zero items), IMF alternate (200, 392 bytes, zero items).

`rba_news` returned one item, below the three-item gate. Not rejected on
merit — the gate is the gate — but worth a retry in a later batch, since a
quiet week is indistinguishable from a broken feed at n=1.
