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

## Why the courier, not the Worker

A Worker has no PDF library and the project allows zero runtime npm
dependencies. So GitHub Actions decrypts and extracts **text**, and POSTs
that text; parsing lives in `parseHousePtrText` with every other parser and
stays testable in this repo. The courier does only what a Worker cannot.
