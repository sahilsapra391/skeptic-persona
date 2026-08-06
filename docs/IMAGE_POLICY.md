# Image policy

**Owner ruling 2026-08-06. This is copy law, not styling.** It sits beside the
no-fabrication rule, and it is enforced the same way: an image that cannot be
traced to payload data or to a named public-domain government source does not
ship, whatever it looks like.

> **The desk never posts a fabricated face.**

## Allowed, exhaustively

1. **Our own renders.** A branded card drawn from fields an ingester actually
   parsed. Every figure on the card is a payload field, subject to the same
   licensing rule as text: if it did not parse, it is not on the card.
2. **Public-domain US government portraits**, from the sources named below and
   no others.

Anything not in that list is banned. There is no third category and no
"just this once" — a face is the one asset where being wrong is unrecoverable.

## Banned, explicitly

- **AI-generated images of real people.** Not for illustration, not for
  placeholders, not stylised. A synthetic face of a named senator is a
  fabricated primary source, and it is worse than a fabricated number because
  it survives a screenshot.
- **Scraped or hotlinked photographs** from any outlet, wire, or exchange.
- **Stock imagery** of any kind, free or licensed.
- **Any image not derived from payload data or a named public-domain source.**

## The portrait source, verified

**Verified 2026-08-06** against the repository's own statement, because the
owner's instruction said to check rather than assume:

**[unitedstates/images](https://github.com/unitedstates/images)** —

> "The photos of members of Congress are from the Government Printing Office,
> which has assured us that all photos are public domain."
>
> "The project is in the public domain within the United States, and copyright
> and related rights in the work worldwide are waived through the CC0 1.0
> Universal public domain dedication."

So: GPO-sourced, CC0, usable for CONGRESS_PTR trade cards.

Also acceptable, same provenance: the **Congressional Pictorial Directory**
(GovInfo), published biennially by the Joint Committee on Printing, a US
Government work.

### One source that looks safe and is NOT

**Library of Congress Prints & Photographs is not uniformly public domain**, and
must not be treated as a portrait source. Its congressional holdings were
acquired "primarily through copyright deposit, gift, and transfers", and the
Library's own rights guidance warns that where copyrighted material is
reprinted, protections may still apply. "It is on a .gov" is not a licence.

Recorded because it is the exact mistake a future session would make while
believing it was following this policy.

## Attribution

Portraits carry their source in the card's footer. Not because CC0 requires it
(it does not) but because this desk's whole claim is that everything it shows
can be traced, and an unattributed face invites the question the policy exists
to answer.

## Render lane and budget

**Recommendation: Cloudflare Workers, not the GitHub Actions path.**

| Lane | Monthly cost | Why |
|---|---|---|
| **Workers (recommended)** | **$0 additional** | Already on Workers Paid ($5/mo, already in the $25 ceiling). Card rendering is SVG string assembly plus a raster step; no new service, no new secret, no new egress. |
| GitHub Actions | $0 direct, but | Private-repo minutes are account-wide and shared with every other private repo. The courier already competes for them, and a render per card puts image generation on the critical path of a runner queue we do not control. |

The deciding argument is not price, it is **latency and coupling**. A card is
worthless late. The Actions path already failed us once this week in exactly
this way: the 13F backfill 403'd on every fetch from a runner while the Worker's
own egress was fine. Putting the image on the same path would make a delivery
depend on a lane we have already measured as less reliable for this repo.

**Budget line: $0/month delta.** If a raster step ever needs a paid binding,
that is a new number and it stops and reports at $5/month per the program rule.

## How the raster step actually works, and why it is free (built 2026-08-06)

The line above said "SVG string assembly plus a raster step" and left the
raster step unspecified. It is specified now, because the obvious answers all
cost money or break a rule:

| Option | Verdict |
|---|---|
| Send SVG | **Impossible.** Telegram `sendPhoto` and X both refuse SVG. |
| Cloudflare Browser Rendering | **Metered, no free allocation on Workers Paid** (verified against the limits page 2026-08-06). A per-card cost on a $0 budget. |
| A WASM rasteriser (resvg et al.) | ~2MB of vendored binary plus real CPU per card, against a repo rule of zero runtime dependencies in the Worker. |
| **Encode the PNG ourselves** | **Chosen.** PNG is a header, a zlib stream of filtered scanlines, and a CRC per chunk. |

The zlib stream comes from `CompressionStream("deflate")`, a Web Standard
present in workerd — **probed before the code was written, not assumed**: it
emits a real zlib wrapper (`0x78 0x9C`), which is exactly what an IDAT chunk
requires. (`deflate-raw` would not work; that distinction is the whole reason
to check rather than remember.)

Text is the part that cannot be improvised, so the brand fonts are **baked at
build time** by `scripts/build-font-atlas.py` into 8-bit coverage bitmaps. The
Worker blits coverage in a brand colour; it never rasterises an outline.

```
alpha coverage   177KB raw -> 55KB deflated -> 74KB base64 in the bundle
                 (Workers Paid allows 10MB compressed: ~1% of budget)
render cost      13ms for the heaviest card (13F breakdown, 1200x920 RGBA)
runtime deps     none
monthly cost     $0
```

### Font licences and attribution

Both faces are **SIL Open Font License 1.1**, which permits bundling and
derivative works — a rasterised atlas is a derivative work and is covered.

- **Archivo** (headings) — Omnibus-Type. <https://github.com/google/fonts/tree/main/ofl/archivo>
- **IBM Plex Mono** (figures) — IBM. <https://github.com/google/fonts/tree/main/ofl/ibmplexmono>

Neither name is used to describe this desk or its output, so the OFL's
reserved-font-name condition is not engaged. The `.ttf` files themselves are
**not committed**; only the derived coverage bitmaps are, and the generator
takes a font directory as its argument.

### One deliberate omission

The atlas has no **em-dash**. Em-dashes are banned in post copy, so making one
undrawable means the ban holds in pixels too, not only in text.

## What is NOT settled here

Whether the account has X Premium, and therefore whether long posts are
available at all, is an **owner question**. It decides whether the
INSTITUTIONAL_13F_BREAKDOWN renders as one long post or as a numbered thread
with the same section order. Nothing in this policy depends on the answer; the
image is one photo either way.
