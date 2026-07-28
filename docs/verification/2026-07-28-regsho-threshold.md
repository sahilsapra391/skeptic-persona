# Verification: Nasdaq Reg SHO threshold list — 2026-07-28T04:18Z

`https://www.nasdaqtrader.com/dynamic/symdir/regsho/nasdaqth20260727.txt`

**HTTP 200, 2,485 bytes.** Pipe-delimited with a header row. Same host the
halts ingester already polls successfully.

```
Symbol|Security Name|Market Category|Reg SHO Threshold Flag|Rule 3210|Filler
AAPD|DIREXION SHS ETF TR DAILY AAPL|G|Y|N|
ADVB|ADVANCED BIOMED INC COM NEW|S|Y|N|
AMDD|DIREXION SHS ETF TR DAILY AMD|G|Y|N|
```

## Why it earns a slot

A security appears here only after **five consecutive settlement days** with
fails-to-deliver at 0.5%+ of shares outstanding. Entry and exit are both
filed, primary-source signals of persistent settlement failure — and the
competitor corpus of 19,518 posts contains **zero** of them.

## THE PRODUCT IS THE DIFF

The list barely changes day to day. What is news is who **joined** and who
**left**, so the ingester stores the previous day's symbol set in the source
cursor and posts only entrants.

**Baseline rule:** on the first observation every symbol looks new. Claiming
that fifty securities "joined" when we simply have no prior list would be
fabrication by omission of context, so the first run records the list and
posts nothing. Tested.

## Format notes

- The filename embeds the settlement date, so the URL is built per poll.
- Weekends and holidays have **no file**; a 404 there is normal and is not
  counted as a failure.
- Only rows whose threshold flag is `Y` are kept.
- Some files carry a trailing record-count line, which is skipped (a row
  whose symbol starts with a digit).
- Market Category is Nasdaq's own letter (`G` global/ETF, `S` small cap) and
  is carried verbatim.

## Doctrine

The list is mechanical and the **reason is never published**. Posts state
that a security joined the list and nothing about why — no naked-shorting
claim, no manipulation claim, no short-seller attribution. There is a test
asserting the draft contains none of those words.

## Fixture naming

Stored as `regsho-threshold.psv.fixture`. A `.txt` anywhere in a fixture
filename breaks `?raw` imports under miniflare — a trap this project hit
before and hit again here.
