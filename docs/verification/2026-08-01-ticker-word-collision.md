# Tickers are words: measuring the grounding-anchor collision

**Date:** 2026-08-01
**Subject:** `checkGroundingProvenance` in `src/rag/validate.ts` (PR #80)
**Why it matters:** provenance failure widens the fabrication whitelist to a
*wrong* document's numbers. This is the one validator whose failure puts
invented facts on the account.

## The claim under test

The gate treated a ticker as a conclusive anchor if it was four or more
characters long, or contained a digit. The premise was that length is a proxy
for distinctiveness. It is not, and this record is the measurement that
settles it.

## Measurement 1 — how many live tickers are ordinary English words

Source: the live `issuers` table in D1 (`skeptic-wire`), queried 2026-08-01.

```
SELECT ticker FROM issuers
WHERE length(ticker) BETWEEN 4 AND 5
  AND ticker NOT LIKE '%-%' AND ticker NOT LIKE '%.%'
```

| Quantity | Value |
| --- | --- |
| Four- and five-character tickers | 5,906 |
| Of those, present in `/usr/share/dict/words` | **371** |

A sample, all live filers we cover: `CASH COST FORM LINE LINK MAIN REAL SAFE
WELL WHEN ELSE SUCH PLAY ROAD PATH LIFE WAVE LOVE NEXT UNIT SITE PLUS`.

`FORM` deserves its own line. It is a live ticker and it appears in the text of
every SEC filing ever written.

## Measurement 2 — how often they collide in real filings

Source: 14 real 8-K filings pulled from the EDGAR daily index for
2026-07-30 and 2026-07-31 (`form.20260731.idx`, `form.20260730.idx`), fetched
with the declared User-Agent, HTML stripped.

Distinct word-shaped live tickers appearing as **bare prose words** per filing:

| min | median | max |
| --- | --- | --- |
| 11 | 23 | 41 |

**Filings containing at least one: 14 of 14.** Appearing in 12 or more of the
14: `BOLD ELSE FORM LINE LINK SION SUCH WELL WHEN WING WRAP`.

So the old rule did not leak occasionally. It licensed every document it was
ever shown.

## Measurement 3 — the delta, run against the shipped code

5,194 (word-ticker, filing) pairs, using the first 15,000 characters of each
stripped filing, evaluated through the real exported `checkGroundingProvenance`
rather than a reimplementation:

| Rule | Pairs licensed |
| --- | --- |
| Old (`>= 4 chars or a digit`) | 79 |
| New (symbol-shape required) | **0** |

## Measurement 4 — the false-negative cost

The new rule requires a symbol to appear the way filings print symbols:
parenthesised or quoted, introduced by an exchange or label, or under a
cover-page `Trading Symbol(s)` heading. The cost of that strictness, measured
against the same 14 filings, taking each filing's own declared cover-page
symbol:

| Real cover-page symbols | Recognised | Missed |
| --- | --- | --- |
| 14 | **14** | 0 |

`ATXG AEMD AIXC LNT ATMCU AMSS AMGN ABR ASH ATNI AN AVB ABBV ANSCU` — all
recognised. Recall on real bodies is unharmed.

A first pass at this measurement reported 5 misses (`ix`, `link` ×4). Those
were an artifact of extracting candidate symbols from raw markup, where
`ix:header` and `link:` are inline-XBRL namespace prefixes, not tickers. The
extraction was wrong, not the rule. Recording it because a measurement that
was corrected is more useful than one that arrived clean.

## What changed

- `IDENTIFIER_FIELDS` split into `CODE_FIELDS` and `SYMBOL_FIELDS`. They are
  not the same class of evidence and merging them was the root error.
- Codes must carry a digit — by construction, not by threshold. Checked
  against 1,500 live payloads: every `cik`, `issuerCik` and `accession`
  present carries digits (0 exceptions), shortest is 7 characters, so the rule
  excludes nothing real.
- Symbols are matched against the **original-case** text. Case is the signal:
  symbols are uppercase in filings, the colliding prose words are not.
  Grounding that arrives already lowercased therefore never matches on the
  symbol and falls through to the name anchor — fail-closed, the direction
  this gate is allowed to be wrong in.
- A symbol that is present but not printed in symbol shape now yields
  `no_anchor` (licensing withheld), not `no_usable_anchor` (fail-open). Having
  something to test with and failing the test is not absence of evidence.

## The lesson worth keeping

This is the third time in this gate that a threshold stood in for a property.
First a single shared token, then a 6-character floor, then a 4-character
floor. Each time the fix moved the boundary rather than removing it, and each
time a real filer sat on the other side of the new boundary. The anchor
coverage audit did not catch any of them, because it asserts that each
archetype **offers** an anchor, not that the anchor **discriminates**. Those
are different properties and the second is the one that matters.
