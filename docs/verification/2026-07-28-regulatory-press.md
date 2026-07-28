# Verification: regulator press feeds — 2026-07-28T02:32Z

## UK FCA — WORKING

`https://www.fca.org.uk/news/rss.xml` — **200, 65,682 bytes, 20 items.**

Carries a `<category>` per item with a clean live taxonomy: **Press Releases,
News stories, Blogs, Statements, Speeches**. That is the selection gate:
enforcement and statements reach the queue, blogs and speeches stay in the
lake.

Dates are a HUMAN format, not RFC-822: `Monday, July 27, 2026 - 15:30`.

## European Commission — WORKING, but not at any obvious URL

| URL | Result |
|---|---|
| `/commission/presscorner/api/rss?language=en&pagesize=20` | **200, valid RSS, 20 items** |
| `/commission/presscorner/home/en/rss.xml` | 200 — but the **SPA HTML shell** |
| `/commission/presscorner/detail/en/rss.xml` | 200 — SPA HTML shell |
| `/info/rss/news_en.xml` | 404 |
| `/commission/presscorner/api/documents?reference=IP&...` | 200 with an **empty body** |

Two of the wrong URLs return **HTTP 200 with an HTML page**, which a naive
"is it 200?" check would accept and a naive XML parse would silently reduce
to zero items. Only `/api/rss` returns real RSS.

Dates are RFC-822 (`Mon, 27 Jul 2026 09:20:41 GMT`), so the two sources in
this family need two date formats between them.

**"Daily News 27 / 07 / 2026"** is a weekday roundup of everything the
Commission published. It is a digest, not an event, and would take a queue
slot every single day, so it is filtered by title.

## Doctrine

Neither feed carries a number. The `REGULATORY_NEWS` templates are therefore
**numberless by construction** — there is no slot a figure could occupy, so
they physically cannot emit one. This is the rule the source roadmap asked
for on prose-only sources, enforced structurally rather than by reviewer
discipline, and there is a test asserting the only permitted slot is a date.
