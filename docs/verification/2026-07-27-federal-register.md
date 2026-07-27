# Verification: Federal Register presidential documents — 2026-07-27T22:52Z

`https://www.federalregister.gov/api/v1/documents.json` with
`conditions[presidential_document_type][]` = `executive_order`,
`proclamation`, `determination`.

**HTTP 200, 10,094 bytes, 6,763 documents available.** No auth, no key, no
rate-limit headers observed.

## What the newest page actually carried

| Kind | # | Signed | Published | Title |
|---|---|---|---|---|
| Executive Order | 14415 | 2026-07-20 | 2026-07-23 | Securing America's Defense Supply Chains |
| Proclamation | 11050 | 2026-07-20 | 2026-07-23 | Made in America Week, 2026 |
| Proclamation | 11049 | 2026-07-20 | 2026-07-23 | Captive Nations Week, 2026 |
| **Proclamation** | **11048** | 2026-07-20 | 2026-07-23 | **Imposing Additional Duties To Offset Canadian…** |
| **Proclamation** | **11047** | 2026-07-20 | 2026-07-23 | **Imposing Additional Duties…** |
| **Proclamation** | **11046** | 2026-07-20 | 2026-07-23 | **Imposing Additional Duties…** |

**Tariffs are imposed by proclamation.** This is the primary document for the
single highest-volume beat in the competitor set (unusual_whales runs tariffs
at 4.4% of volume with an 87,775 ceiling) — and they cite WSJ and CNN for it.

## FILTER CORRECTION

`conditions[type][]=PRESDOCU` returns **nothing**. An earlier probe combining
`PRESDOCU` and `RULE` came back with 20 documents, all of them Rules, and
looked perfectly healthy — the classic silent-filter failure. The working
filter is `conditions[presidential_document_type][]`, and the returned `type`
string is `"Presidential Document"` while `subtype` carries
`"Executive Order"` / `"Proclamation"`.

## Fields verified

`document_number`, `title`, `type`, `subtype`, `publication_date`,
`signing_date`, `executive_order_number`, `proclamation_number`, `html_url`,
`abstract`.

On the general (non-presidential) endpoint, `effective_on` populated on 18 of
20 records and `comments_close_on` on 3 of 20 — so the compliance-runway
metric is broadly available and the lobbying-window metric is occasional.
Those ride in a later chunk covering rules.

## Notes

- `signing_date` vs `publication_date` gives a parsed lag; EO 14415 was
  signed on a Monday and published on the Thursday.
- Ceremonial proclamations ("… Week, 2026") are roughly half of all
  proclamations. The ingester filters them as a SELECTION heuristic on a
  parsed title — it decides what asks for attention and never appears in a
  post, so a miss costs a queue slot rather than a false statement.
