# Global wire fanout — 86 probed, 20 adopted

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

## GDELT: rejected on doctrine

**This entry corrects an earlier one.** The first version of this section read
"usable, deferred" — the 429 in batch 1 was transient, it returns articles on
retry, and the only obstacle looked like it being JSON rather than RSS. On
that reading it was a chunk waiting to be written.

That was wrong, and the transport question hid the real one. Fetching the
payload settles it:

```
domain=biz.heraldcorp.com   (Korean)  "…美, 북한 핵 자금줄 이곳 정조준"
domain=ria.ru               (Russian) "ЕС может отказаться от крупных
                                        пакетов санкций… пишет FT"
```

The second one translates as *"the EU may abandon large sanctions packages
against Russia, **the FT writes**"*. That is a Russian outlet relaying what a
British newspaper reported. **GDELT does not publish facts; it indexes other
people's coverage of them.**

So it fails non-negotiable **#2** (primary sources only, no "reportedly") on
every single row, and arguably **#3** as an aggregator's product. No parser
would fix that, because the parser was never the problem.

Recorded loudly because the earlier "deferred to its own chunk" framing was an
open invitation for someone to spend a chunk building it. **A source has to
clear doctrine before transport is worth discussing**, and I checked those in
the wrong order — the probe script only ever asked whether bytes came back.

## Rejected (17 across both batches)

Batch 2 adds: FDIC and FINRA (404 on both alternate paths tried), NHTSA (403),
USPTO (404), Bundesbank (404), Banque de France (403), Norges news (404),
HKMA (404), ASIC (404), BoJ statements (404), Banxico (404), MAS Singapore
(200, 854KB of HTML, zero items), OCC (200, HTML, zero items), Banco Central
do Brasil (200, HTML, zero items), IMF alternate (200, 392 bytes, zero items).

`rba_news` returned one item, below the three-item gate. Not rejected on
merit — the gate is the gate — but worth a retry in a later batch, since a
quiet week is indistinguishable from a broken feed at n=1.

---

# Batch 3 — 42 more probed, 6 adopted

**Verified 2026-08-01T23:1xZ**, same declared UA, same two gates.

Twelve of the 42 returned 200 with three or more items. **All twelve then
parsed cleanly through `parsePressFeed` on the first attempt** — where batch 1
had four of eight parse to zero.

That is not the batch-3 feeds being better behaved. It is the batch-1 dialect
work (RSS 1.0/RDF, Atom `<entry>`, CDATA on any field, four candidate date
fields) covering the shapes that exist. Batch 3 contributed two Atom feeds
(gov.uk) and a Swiss feed, and the parser had already met all of it.

## Three of the twelve were already registered

`press_ftc_competition`, `press_fca` and `press_eu_commission` came back
"usable" under URLs **identical** to rows already in `PRESS_SOURCES`. The
probe list was written from the plan document and never diffed against what
the desk already polls.

Nothing broke, because I read the source list before writing the config. Had I
not, they would have been adopted a second time under new ids: double the poll
rate against three hosts, and every item filed twice for dedup to absorb.

A test now asserts **no two `PRESS_SOURCES` share a URL**. The next duplicate
fails CI rather than depending on someone noticing.

## Adopted (6)

| Source | Authority | Why it earns a slot | Filter |
|---|---|---|---|
| `press_bea` | Bureau of Economic Analysis | GDP, PCE, trade balance — the releases themselves | none |
| `press_eia` | US EIA | "Today in Energy": EIA reading its own series | explainers |
| `press_wto` | WTO | Disputes, panel reports, quarterly goods trade | donations, explainers |
| `press_cma` | UK CMA | Merger inquiries, named parties in the title | gov.uk doc prefix |
| `press_hmt` | HM Treasury | Budget and fiscal announcements | gov.uk doc prefix |
| `press_finma` | FINMA | Proceedings concluded against named Swiss firms | German items |

### gov.uk serves a document library, not a wire

CMA and HMT are the same endpoint shape: one Atom feed per organisation,
carrying **everything that organisation publishes**. The CMA's Vodafone / CK
Hutchison merger inquiry arrives interleaved with "Transparency data: CMA:
spending over £500, June 2026".

The separator is that gov.uk prefixes documents with their type and leaves
press releases unprefixed. The filter is an **explicit list** of those types
rather than a `/^[A-Z][a-z ]+:/` shape, because a real headline can lead with
a colon too ("Vodafone: CMA opens phase 2 inquiry") and that one must survive.

### FINMA's English feed is not all English

`finma.ch/en/rss/news/` returns roughly half its items in German —
"Aktualisierte Sanktionsmeldung: Russland". The desk has no translator, so
posting one means relaying a regulator's exact wording in a language nobody
here read.

The filter drops the German openers. **Only `Aktualisierte` was observed; the
others are prophylactic, and a German item opening some other way still gets
through.** That residual risk is stated rather than papered over. The general
lesson is the transferable part: **an `/en/` path is a routing hint, not a
guarantee about content.**

## Rejected on editorial grounds, not on fetch (2)

Both return clean, well-formed, parseable feeds. Neither carries market
intelligence, which the first two gates cannot see.

**CBO** — 12 of 12 recent items are cost estimates for individual bills
("S. 3747, Home School Graduation Recognition Act"). The publications that
matter (Budget and Economic Outlook, Monthly Budget Review) exist but are rare
enough that catching them needs an **allowlist**, and `skipTitle` is a
blocklist. Wants its own chunk if it is worth having at all.

**DOL** — grant awards, single-restaurant back-wage recoveries, OSHA citations
against individual contractors. The one recurring item worth having is the
Unemployment Insurance Weekly Claims Report, and its numbers live in a data
file rather than the title, so a headline-only lane could not say anything
about it. Wants a dedicated ingester, not a press row.

This is a **third rejection class**, and it is the one the automated gates are
blindest to. Batch 1 rejected on transport (404/403) and on shape (parsed to
zero). Batch 3 adds *parses perfectly, says nothing worth saying*. Only
reading twelve real titles per feed surfaced it.

## Rejected on fetch (30)

404: Treasury news, FERC, NLRB, GSA, Ofgem, BaFin, AMF France, SNB, CONSOB,
DNB Netherlands, Norges alternate, JFSA, HKMA alternate, HKEX, APRA, ACCC,
BIS, World Bank, OSFI, StatCan.
403: Treasury OFAC XML, FAA, USDA, CNMV, RBNZ, OECD.
Other: NRC (503), EPA (202, empty body).
200 with zero items: MAS Singapore (854 KB of HTML).

`rba_retry` returned **one item again**, unchanged from batch 1. Two probes a
day apart both at n=1 is now weak evidence the feed is genuinely near-empty
rather than momentarily quiet, but one item is still below the gate. Left
parked.

The 403s remain parked rather than worked around. Doctrine #4: the client
declares itself, and a host that refuses a declared UA has answered.

---

# Payload depth, measured across all 20 adopted feeds (2026-08-01)

Prompted by the RAG session's observation that **reachable, parseable and
useful are three different things, and the probe only tests the first two.**
Worth checking, because this batch took press from 6 sources to 26 — the
majority of the desk — and a press payload is the thinnest thing we ingest.

A press payload carries five fields: `authority`, `title`, `categories`,
`publishedIso`, `factLine`. The last is derived from the other four. Zero
parsed numbers, by design and by the module's own header comment.

Measured over the 60 items in the adopted fixtures:

| | count | share |
|---|---|---|
| title carries a money figure | 1 | **2%** |
| title carries any non-date number | 3 | 5% |
| description carries a money figure | 5 | 8% |
| description carries any non-date number | 16 | 27% |
| **description EMPTY** | **21** | **35%** |

So for roughly a third of press items the whole record is an authority, a
headline, a date and a link. The commentary floor is 200 weighted characters.
There is no honest way to fill that from a headline, which is precisely the
pressure that makes a model reach outside the record.

## Nine of the 21 empties were a parser bug, and it is the batch-1 bug again

`parseDescription` read `extractFirst(item, "description")` and nothing else.
OFSI, CMA and HM Treasury are Atom and carry `<summary>`; none of them has a
`<description>` element at all.

Before and after, per source, measured rather than inferred:

```
BEFORE  cma=0/3  hmt=0/3  ofsi=0/3      (17 other sources unchanged)
AFTER   cma=3/3  hmt=3/3  ofsi=3/3
```

Empty descriptions: **21 of 60 (35%) → 12 of 60 (20%)**.

Batch 1 taught the parser Atom's item element, Atom's link attribute and
Atom's date fields. The body was left behind. **Nothing failed** — the items
parsed, queued and posted, just thinner — which is why it survived a batch
that was explicitly about dialect coverage.

Worth recording that a first pass at this attributed the gain to five more
sources as well. Re-measuring with the fix stashed showed only three changed.
The extra four were already fine, and claiming them would have overstated the
fix by half.

## The remaining 12 are correct, each for its own reason

- **ECB (3)** — no `<description>` element of any kind. Title-only feed.
- **SEBI (3)** — description is a verbatim copy of the title. Refused by the
  duplicate guard, which is right: storing it would look like grounding
  coverage while teaching the model nothing. Now pinned by a test, because
  widening the tag list could have opened a path around it.
- **SEC speeches (3)** — 29 characters, below the 40-char floor.
- **CFPB, DOJ, Riksbank (1 each)** — individual items.

## What this does not fix

The 2% money-figure rate is not a bug and cannot be parsed away. It is what a
regulator press feed is. The consequence belongs to whoever owns the
commentary floor: **26 of ~35 sources structurally cannot fund a 200-character
commentary from their own record**, and that ratio is a result of this batch.
Recorded here so the source count and the generation pressure are visible in
the same place.
