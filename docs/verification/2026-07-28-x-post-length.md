# X post length — verification

**Verified:** 2026-07-28
**Why this record exists:** `p2r-01` shipped with the X numbers flagged
UNVERIFIED in CLAUDE.md. They had arrived by assumption during the platform
pivot and were briefly filed under a header claiming 2026-07-26 verification,
which was wrong. `p2r-02` sizes `POST_TEXT_LIMIT` against them, so verifying
them first was a gate on this PR.

## Source

`https://developer.x.com/en/docs/counting-characters` returns **HTTP 402
Payment Required** to an unauthenticated fetch, so the published documentation
page is not usable as a primary source.

Used instead: **`twitter-text` config v3**, the reference implementation X
publishes and the one every character counter is built on:
`https://raw.githubusercontent.com/twitter/twitter-text/master/config/v3.json`

```json
{
  "version": 3,
  "maxWeightedTweetLength": 280,
  "scale": 100,
  "defaultWeight": 200,
  "emojiParsingEnabled": true,
  "transformedURLLength": 23,
  "ranges": [
    { "start": 0,    "end": 4351, "weight": 100 },
    { "start": 8192, "end": 8205, "weight": 100 },
    { "start": 8208, "end": 8223, "weight": 100 },
    { "start": 8242, "end": 8247, "weight": 100 }
  ]
}
```

Corroborated on the headline numbers (280 free / 25,000 Premium, URLs at 23) by
independent secondary sources, but the config file is what the implementation
follows.

## The finding that changed the implementation

**`String.length` is the wrong measure, and it is wrong in both directions.**
The original plan said "rename to `POST_TEXT_LIMIT = 280` with link
accounting", which would have been a one-line change and would have been wrong.

The algorithm is: sum a weight per code point, divide by `scale` (100). Code
points inside the four ranges weigh 100; everything else weighs 200. Emoji are
parsed as clusters and each cluster counts as one code point at the default
weight. URLs are replaced by their t.co form and billed at exactly 23.

Two concrete divergences, both of which persona.md §6 actually permits:

| text | `String.length` | X counts | why |
|---|---|---|---|
| `🇮🇳` | 4 | **2** | one emoji cluster; two code points, each a surrogate pair |
| `日` | 1 | **2** | outside every weight-100 range |

So a naive check would have **refused publishable posts** (70 country flags are
280 to JS, 140 to X) and **accepted over-long ones** (141 CJK characters are 141
to JS, 282 to X). persona.md permits country flags on rate decisions and 🟢🔴
for tape, so this is live surface, not a theoretical edge.

Also worth recording: the em-dash `—` (U+2014) sits in the `[8208, 8223]` range
and weighs 1. It is banned in post copy for other reasons, but it must still be
*counted* correctly.

## What we implemented

`src/templates/length.ts`, zero dependencies, pinned by `test/length.test.ts`.

Cluster detection is **partial by design**. Shipping the full Unicode emoji
table into a Worker is not worth it, so we collapse only the three shapes we
can identify unambiguously:

- regional-indicator pairs (flags)
- ZWJ sequences
- attaching modifiers (VS16, skin tones, keycap)

**The safety property is that failure is conservative.** An unrecognised emoji
is counted per code point, which over-counts. That can waste a few characters
of budget; it can never let an over-long post through. There is a test asserting
this direction explicitly.

NFC normalisation is applied first, matching twitter-text: `e` + combining acute
is two code points to us and one character to X.

## Not verified here, and deliberately so

- **Link deprioritisation.** The claim that X down-ranks posts carrying
  external links is widely repeated and not something we can verify from a
  config file. It is the reason the plan puts the source link in a reply rather
  than the post body. Treated as a product decision, not a stated fact, and it
  is not asserted anywhere in CLAUDE.md.
- **The 25,000-character Premium limit.** Irrelevant while the account is on
  the free tier. If Premium is ever bought, `POST_TEXT_LIMIT` is the one
  constant to change and `maxWeightedTweetLength` in the config above is where
  to re-check the number.
- **Live behaviour of the compose box.** No API access and no account
  automation, by design. The config file is the authority we act on.
