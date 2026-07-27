# Verification: CFTC Commitments of Traders + NSE India — 2026-07-27T23:23Z

## CFTC Traders in Financial Futures — WORKING

`https://publicreporting.cftc.gov/resource/gpe5-46if.json`

**HTTP 200, 91 distinct contracts.** No auth, no key, no rate limiting
observed. Socrata `$where`/`$order`/`$limit` all honoured.

Live values, week ending 2026-07-21, E-MINI S&P 500:

```
open_interest_all           1969636
lev_money_positions_long     134932
lev_money_positions_short    496807
change_in_lev_money_long     -15624
change_in_lev_money_short    -14218
```

**Why this source is unusually safe:** CFTC pre-computes every week-over-week
delta. The only arithmetic we perform is long minus short. The
no-fabrication rule is satisfied by construction rather than by discipline.
Nobody in the 33,682-post competitor corpus posts it.

Contract names are idiosyncratic and are copied VERBATIM from the live API
("NASDAQ MINI", "ULTRA UST 10Y", "RUSSELL E-MINI"). A near-miss name returns
an empty set with a healthy 200 — the silent-filter failure class again.

Watchlist: E-MINI S&P 500, NASDAQ MINI, RUSSELL E-MINI, ULTRA UST 10Y,
ULTRA UST BOND, VIX FUTURES, FED FUNDS, EURO FX, JAPANESE YEN.

---

## NSE India (nsearchives.nseindia.com) — BLOCKED, PARKED

`https://nsearchives.nseindia.com/content/equities/bulk.csv`

Tested three ways from the same machine, same second:

| Attempt | Result |
|---|---|
| HTTP/2, declared UA `Skeptic Wire admin@spechawk.ai` | **connection reset** (`INTERNAL_ERROR`) |
| HTTP/1.1, declared UA | **connection reset** |
| HTTP/1.1, Chrome UA | **HTTP 200, 16,106 bytes** |

The block is **User-Agent based**, not IP-based or protocol-based: the same
request succeeds the instant the client claims to be a browser.

**DECISION: parked, not worked around.** Non-negotiable #4 forbids disguising
the client to evade a block, and that rule does not bend because the data is
attractive. This is the same call made for Senate eFD on 2026-07-27, which
403s Cloudflare egress.

An earlier roadmap pass reported this host as "plain CSV, no challenge" —
that finding is superseded by the test above. The F&O ban list
(`/content/fo/fo_secban.csv`) fails identically.

**If India coverage matters later**, the honest routes are: an official NSE
data licence, or a data-sharing arrangement that gives us credentials. Not a
spoofed header.
