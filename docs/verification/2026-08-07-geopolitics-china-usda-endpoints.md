# p5-22 / p5-23 / p5-24 / p5-25 — endpoint verification

Probed 2026-08-07 from a residential connection with the declared UA.
Endpoint verification is law here: none of these lanes gets built on a
remembered URL, and three of the four turned out to need no build at all.

## p5-22 geopolitics — ALREADY DELIVERED, plus one exclusion

Owner decision 1 was "in, narrow list", and B-03.4 made the list my default
ruling. The list decided itself: only three candidates answer, and **two of
them are already in production**.

| Body | Path 1 | Path 2 | Verdict |
|---|---|---|---|
| WTO | `library/rss/latest_news_e.xml` **200, 10 items** | — | **already ingested** |
| European Commission | `presscorner/api/rss` **200, 10 items** | — | **already ingested** |
| UN News | `news.un.org/...all/rss.xml` 200, 30 items | — | live, but see below |
| IMF | `News/RSS?language=eng` **403** | `external/rss/feeds.aspx` 200 HTML, 0 items | dead |
| NATO | `natolive/rss_news.xml` **404** | `natohq/news.htm?format=rss` 200 HTML, 0 items | dead |
| IAEA | `feeds/topnews.rss` **404** | `rss/pressreleases.xml` **403** | dead |
| World Bank | `news/all.rss` **404** | `wbfeeds/press-releases.xml` 200 HTML, 0 items | dead |
| OPEC | `rss_press_releases.xml` 200 HTML, 0 items | `rss/press_releases.xml` **403** | dead |

Two documented paths per retirement, the ACCESSWIRE discipline.

### The duplication, confirmed in production

```
press_eu_commission   0 fails   last_ok 2026-08-07T20:46Z   52 items
press_wto             0 fails   last_ok 2026-08-07T20:30Z   12 items
```

`press_wto` uses `https://www.wto.org/library/rss/latest_news_e.xml` — the
exact URL this probe hit. `press_eu_commission` uses
`https://ec.europa.eu/commission/presscorner/api/rss`, likewise. Both are
healthy right now. **Building a geopolitics lane over these bodies would have
produced a second ingester for feeds already flowing.**

### UN News is live and editorially wrong for this desk

The feed answers 200 with 30 items. Its actual content, sampled the same
minute:

> Ebola in DR Congo: Childhood deaths rise · 'A clear violation': Guterres
> deplores deadliest attack on Kyiv this year · 'Wanton, intentional infliction
> of incredible pain' by gangs in Haiti · Gaza: 300 children killed · Peacock
> party takes pride of place

One item in twelve was market-adjacent (July food prices). This is
humanitarian reporting, and a market-intelligence desk publishing casualty
counts and outbreak deaths as market signal would be a serious editorial
error, not merely noise. **Excluded on fit, not on reachability.**

## p5-23 China official-English — NO MACHINE-READABLE ENDPOINT

Eight paths across two rounds. Every one is an HTML page; not one is a feed.

```
PBoC english        200 text/html   106,664B   0 items
PBoC .rss           404
NBS english         200 text/html    11,974B   0 items
NBS english rss     404
CSRC english        200 text/html    19,652B   0 items
China Customs en    200 text/html    31,143B   0 items
MOFCOM english      404
China Daily biz     404  (and a news outlet, which is banned as citation anyway)
```

The sites are reachable; there is nothing structured to parse. This lane is
HTML-scrape-or-nothing against foreign government pages with no declared feed,
no stated UA policy and no change notification.

## p5-24 USDA WASDE — NO FEED, AND THE API NEEDS A KEY

Ten paths across two rounds.

```
usda.gov/oce/commodity/wasde/rss.xml    404
usda.gov/rss/latest-releases.xml        403
nass.usda.gov/rss/Newsroom.xml          404
ers.usda.gov/rss/recent-publications    404
usda.gov/media/press-releases/feed      403
usda.library.cornell.edu ... .json      404
usda.library.cornell.edu ... .rss       404
nass.usda.gov/Publications/Calendar     404
NASS QuickStats API                     401  <- exists, needs a key
USDA OCE WASDE page                     200 text/html 164,127B, no feed
```

The one live structured route is **NASS QuickStats, which returns 401 without
an API key**. That is a free key, but it is a credential, and credentials are
the owner's to obtain. The alternative is content-diffing a 164 KB HTML page,
which the BLS lane already does elsewhere but which is a much heavier lift for
a monthly report.

**Owner decision, one line: get a free NASS QuickStats API key, or p5-24 stays
excluded.**

## p5-25 Bluesky — BUILT, SHIPPED OFF

```
com.atproto.server.describeServer   200 application/json  (unauthenticated)
app.bsky.actor.getProfile           200 application/json  (unauthenticated)
app.bsky.feed.searchPosts           403                   (AUTH REQUIRED)
```

That 403 is the load-bearing result: search is the only endpoint that answers
the question the lane exists to ask, and it refuses anonymous callers. So the
lane needs a session, which needs both `BLUESKY_APP_PASSWORD` (already set as
a Worker secret) and `BLUESKY_IDENTIFIER` (the handle, **not yet set**).

The lane is complete, tested, and inert behind `BLUESKY_ENABLED` (default
off). It cannot card by construction: log-only score, no archetype, no
attribution entry, no `enqueueForApproval` call, asserted by a test that reads
the shipped source.

**Owner action to activate: set `BLUESKY_IDENTIFIER` to the handle the app
password belongs to, then flip `BLUESKY_ENABLED` to `true`.**
