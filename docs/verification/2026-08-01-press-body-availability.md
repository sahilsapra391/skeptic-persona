# Press feed body availability — measured 2026-08-01

Measured because `press_*` was the second-thinnest postable source group
(208 items at 5 payload fields). Before building anything, the question was
which of the six feeds actually ship a usable `<description>`.

A description equal to the item's own title counts as unusable: it adds
nothing the payload does not already carry.

| Source | Items | With body | Median chars | Verdict |
|---|---|---|---|---|
| `press_ftc_competition` | 30 | 30 | 2,353 | usable body |
| `press_fca` | 20 | 20 | 2,129 | usable body |
| `press_eu_commission` | 20 | 20 | 269 | usable body |
| `press_sec_enforcement` | 25 | 1 | 54 | none |
| `press_cftc_enforcement` | 10 | 0 | 0 | none |
| `press_boj` | 43 | 0 | 0 | none |

Three feeds are already covered: p4-01 captures the RSS description at ingest,
so those rows ground correctly from now on.

## The three with no description link to PDFs

This is the part that mattered, and it is not a gap — it is a hazard.

```
press_sec_enforcement -> https://www.sec.gov/files/litigation/admin/2026/ia-6984.pdf
press_boj             -> http://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/mpr260731b.pdf
```

`src/rag/sourceText.ts` fetches `source_url` when `raw_text` is absent, runs
`htmlToText` over it and caches the result write-once. There was no
content-type or magic-byte check, and this repo already documents that SEC's
content-type headers lie.

Tag-stripping a PDF does not fail. The SEC document yields **106,641
characters** of object tables and byte offsets — `/Length 93`, `/Prev 223302`,
`/Size 312`. Those are digits, and the generation validator widens its
whitelist to payload ∪ source, so **a PDF's internal structure would have
licensed its own numbers as facts a post may state.**

The fetch returns 200. The extracted text is not empty. Nothing reports a
problem. Non-negotiable #1, reached through a success.

`looksBinary` now guards `htmlToText`, which returns empty for a binary body.
`sourceText.ts` already discards an empty extraction, so a PDF-linked item
keeps `raw_text` NULL and grounds on payload alone — no change needed on the
generation side.

## `press_cftc_enforcement` stays unfetchable regardless

`www.cftc.gov` 403s Worker egress (verified 2026-07-27) and is already on the
generation path's refusal list. Its ten items ground on payload alone. The
relay covers ingestion; it does not make the host reachable for a body fetch.

## What is NOT worth widening

`halt` (7.7 fields) and `regsho_threshold` (6.0) read thin and are
intrinsically so. persona.md's own beat is "The code is the whole story so
far." Symbol, reason code and time IS the halt. Widening those would invent
substance the record does not have.
