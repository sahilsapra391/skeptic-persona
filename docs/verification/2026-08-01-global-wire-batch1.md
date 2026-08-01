# Global wire fanout, batch 1 — twenty probed, eight adopted

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
