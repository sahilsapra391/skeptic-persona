# Verification: House PTR PDFs — 2026-07-28T05:10Z

`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{docId}.pdf`

Six live filings fetched. **HTTP 200**, ~64 KB each.

## The PDFs ARE extractable

An earlier note in the ingester assumed e-filed (8-digit) DocIDs were
"text-layer but RC4-encrypted — transaction tables extractable". Confirmed,
with the details that matter:

- **Encrypted: yes.** `/Encrypt` present.
- **Owner password: EMPTY.** `PdfReader.decrypt("")` returns 2 (success).
- **Text layer: real.** 997 chars from a one-page filing, 3,717 from a
  three-page one. Not a scan — the `DCTDecode` stream is a logo.

## Structure (verified across two filings)

```
DC Applied Materials, Inc. - Common
Stock (AMAT) [ST]
P 06/18/202606/30/2026$1,001 - $15,000
F S: New
S O: Morgan Stanley Active Assets (5)
```

- Owner prefix is **optional**: `SP` spouse, `DC` dependent child, `JT`
  joint, **absent** when the filer is the owner.
- Asset name wraps across one or two lines, ending `(TICKER) [TYPE]`.
- **The two dates arrive CONCATENATED** with no separator, and the amount
  band follows immediately: `06/18/202606/30/2026$1,001 - $15,000`.
- Header text is peppered with **NULL bytes** from a font-encoding quirk
  (`P\0\0\0 T\0\0\0 R` is "PERIODIC TRANSACTION REPORT"). Data lines are
  clean; nulls are stripped before parsing.

## THE TRAP THAT COST A REAL TRADE

When an asset name is short enough not to wrap, **the name and the
transaction share one line**:

```
Home Depot, Inc. (HD) [ST] P 06/17/202606/30/2026$1,001 - $15,000
```

A start-anchored transaction pattern parsed 15 of 16 transactions in the
three-page filing and **silently dropped the Home Depot purchase entirely**.
That is fabrication by omission: the post would have looked complete with a
trade simply missing.

Caught only by comparing a loose substring count (16) against the anchored
match count (15) — the two fixtures alone would not have revealed it, because
the single-transaction filing has a wrapped name.

## The completeness check

`countTxnMarkers()` counts the same transactions with a deliberately LOOSE
pattern (the concatenated date pair plus a dollar sign, anywhere in the text)
so the strict parser can be checked against something other than itself.

That is the only reason the Home Depot bug was findable: 15 parsed rows look
exactly like a 15-transaction filing. **A completeness check has to count
against a signal the document emits, not against what the parser managed to
read.**

Both live fixtures now assert `countTxnMarkers(text) === parseHousePtrText(text).length`.

## Live extraction run, 2026-07-28

Four e-filed PDFs pulled from production `items` and run through
`scripts/extract_house_pdfs.py` (pypdf 5.1.0) end to end:

| DocID | Member | Pages | Markers | Parsed |
|---|---|---|---|---|
| 20035068 | Pete Sessions | 1 | 1 | 1 |
| 20034963 | Jared Moskowitz | 3 | 16 | 16 |
| 20035075 | Sam T. Liccardo (fund) | 1 | 1 | 1 |
| 20034736 | Sam T. Liccardo (NVDA) | 1 | 1 | 1 |

All four decrypt with an empty owner password and carry a real text layer.

**Two of the four initially failed, and the completeness check is why we
know.** They contained shapes neither original fixture had:

1. **`S (partial)` type token** — the pattern required a bare capital letter,
   so filing 20034736 parsed 0 of 1 transactions.
2. **Amount band wrapped across two lines** — `"...07/22/2026$15,001 -"` then
   `"$50,000"`. The pattern required a complete band at end of line.
3. (Cosmetic, same run) a non-traded asset `Opportunity Fund II (GLAS Funds,
   LP) [HN]` kept a stranded `[HN` because the tail pattern required a ticker
   before the bracket. The parenthesis there is part of the fund's NAME —
   reading it as a ticker would have invented one.

Both parsing failures were silent by nature: the filing would have been logged
with zero transactions and simply never posted. `countTxnMarkers` disagreeing
with the parser is what surfaced them. Both shapes are now permanent fixtures
(`house-ptr-partial-wrapped`, `house-ptr-untraded`).

## Why the courier, not the Worker

A Worker has no PDF library and the project allows zero runtime npm
dependencies. So GitHub Actions decrypts and extracts **text**, and POSTs
that text; parsing lives in `parseHousePtrText` with every other parser and
stays testable in this repo. The courier does only what a Worker cannot.

## Production run, 2026-08-01: the gate as a map of blind spots

The courier ran for real. Of 322 indexed House filings, **41 extracted
cleanly**, 3 were scans with no text layer, and **6 were refused by the
completeness check** — the document's own marker count disagreed with the
parser, so no partial trade list reached the queue.

Those six were not noise. Every one was a parser blind spot, and fixing them
recovered five filings:

| Filing | Shape | Outcome |
|---|---|---|
| 20033718 | space between the date pair and the amount | fixed |
| 20033916 | `CommonP` (page-break truncation) | **refused (truncated cell)** |
| 20034036 | `[ST]P` glue | fixed |
| 20034138 | `[ST]S` glue | fixed |
| 20034489 | `[ST]P` glue (2 rows) | fixed |
| 20034660 | row split across a page break | **still refused, deliberately** |

### The two shapes fixed

The transaction code is not reliably preceded by whitespace; the extractor
glues it to whatever ends the asset cell:

```
Procter & Gamble Company (PG) [ST]S 01/29/202601/30/2026$1,001 - $15,000
JP Morgan Chase & Co. CommonP 01/16/202601/30/2026$1,001 - $15,000
```

A closing bracket or a lowercase letter is therefore a valid boundary. An
UPPERCASE one is not: `(XOM)P` would be indistinguishable from a ticker
losing its last character. Both are LOOKBEHINDS — consuming the `]` would
strip the `[ST]` the tail parser needs.

Whitespace between the dates and the amount is optional for the same reason:
`P 12/18/202512/19/2025 $100,001 - $250,000`.

### The one left refused, on purpose

Filing 20034660 opens a band `$15,001 -` at the foot of one page and closes it
on the next, after the page footer and a **repeated table header**. That
header contains the literal string `$200?` (the "Cap. Gains > $200?" column).

Any rule that reached forward for the next line beginning with `$` would
splice **`$15,001 - $200`** into a member of Congress's trade record. The
completeness gate holds the filing instead, which is the correct outcome and
strictly better than a plausible wrong number. Pinned by a test that asserts
the parser reads 15 of 16 and that no amount contains `$200`.

## Review correction: the lowercase boundary was hiding truncation

The p4 session's adversarial review caught this, and it is in the
completeness gate rather than beside it.

Widening the transaction-code boundary to accept a lowercase letter looked
like another glue rescue. It is not. **Every intact House asset cell ends in
`[TYPE]` or `)`**, so a code sitting directly after a lowercase letter can
only happen when the rest of the cell is on the next page:

```
JP Morgan Chase & Co. CommonP 01/16/202601/30/2026$1,001 - $15,000
                     ^ "Stock (JPM) [ST]" is overleaf
```

Accepting it parsed the row with a truncated name and a null ticker, so
`tradeClause` printed the fragment as the asset. Worse, it made
`countTxnMarkers` agree with the parser, so the gate reported COMPLETE and
promoted the filing.

**That destroyed the only detector for page-break truncation.** The count is
satisfied while the content is short, which is the one shape a marker count
cannot see — the same blind spot the Home Depot regression exposed from the
other direction.

Reproduced on the page-break fixture with the XOM band un-wrapped:

| | markers | parsed | gate |
|---|---|---|---|
| with the lowercase branch | 16 | 16 | **passes** |
| after the fix | 16 | 15 | refuses |

A lowercase boundary now requires the cell to have terminated properly;
otherwise the row is skipped and the gate refuses the filing exactly as
before. The bracket boundary is untouched, so **four** real recoveries stand.

**20033916 is no longer one of them, and the table above is corrected to say
so.** Both its rows are the `CommonP` shape, so it now reads markers 2 /
parsed 1 and the gate refuses it. That is the correct outcome -- its asset
cells genuinely are split across a page break -- but the earlier version of
this document called it fixed. An operator seeing it refused against a doc
promising a fix would reasonably "re-fix" the lowercase boundary and
reintroduce the truncation. Recoveries are 20033718, 20034036, 20034138 and
20034489; 20033916 and 20034660 are both correctly refused.
