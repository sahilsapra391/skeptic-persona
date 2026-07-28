# Verification: EDGAR daily index — 2026-07-28T04:14Z

`https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260727.idx`

**HTTP 200, 798,399 bytes.** Declared UA, same host the pipeline already
polls.

## The day's actual census (2026-07-27)

| Form | Filed |
|---|---|
| 4 | 588 |
| 424B2 | 556 |
| NPORT-P | 501 |
| **SCHEDULE 13G** | **432** |
| 13F-HR | 297 |
| **8-K** | **226** |
| **144** | **166** |
| S-3ASR | 118 |

## Why this matters immediately

Our Schedule 13 ingester polls **40 entries per feed**. The SEC filed **432
Schedule 13Gs** that day. Every EDGAR poller reads `getcurrent`, which is a
rolling window — if a form type spikes, or a poll fails, or a form-type
string is subtly wrong, filings vanish **with no error anywhere**: HTTP 200,
valid Atom, simply fewer entries.

That is precisely how the `SCHEDULE 13D` naming bug hid (`type=SC+13D`
returned 1 entry instead of 40 and looked perfectly healthy).

This job turns a silent miss into a number.

## Format notes

- **FIXED-WIDTH, not delimited.** The form type occupies columns 0–11 and
  company names contain spaces, so any whitespace split mis-parses every row.
- Rows begin after a `---` separator line.
- Weekends and holidays have **no index** — a 404 there is normal and is not
  counted as a failure.
- The filing day is **Eastern**; our `event_at` is UTC. The comparison uses an
  ET day window, or filings after 20:00 ET land on the wrong side of the
  boundary.

## Scope

This is an **audit, not a post source**. Results are stored as a lake-only
item (`score = log-only`, `status = logged`) so the history is queryable.
Our own bookkeeping is never news.
