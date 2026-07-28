# openFDA food enforcement — endpoint verification

**Verified:** 2026-07-28

## Endpoint

`https://api.fda.gov/food/enforcement.json?limit=30&sort=report_date:desc` → **200**.
29,264 records available; `meta.last_updated` was `2026-07-22`.

## Field parity with drug enforcement

Every field `parseRecalls` reads is present in the food dataset under the same
name, so one parser, one grouper and one archetype cover both:

`event_id`, `recalling_firm`, `classification`, `status`, `reason_for_recall`,
`product_description`, `product_quantity`, `distribution_pattern`,
`voluntary_mandated`, `recall_initiation_date`, `report_date`.

Verified programmatically, not by eye.

## Volume, and why food is Class I only

Grouped by `(event_id, classification, reason_for_recall)` over a 61-day
window:

| Grade | Grouped events | Per month |
|---|---|---|
| Class I | 36 | **17.7** |
| Class II | 67 | 33.0 |
| Class III | 20 | 9.8 |

Drug over 92 days, for comparison: Class I 2.6/month, Class II 25.1/month.

Food Class II is mostly undeclared allergens at regional producers. Those are
real public-health notices and they stay in the lake, but they are not market
intelligence, and the queue already expires more cards than it approves (242
expired against 19 approved at time of writing). Drug Class II is kept because
a sterility failure or a CGMP deviation names a manufacturer that is usually a
listed company.

The GRADE is FDA's. Which grades are worth interrupting the owner for is ours,
so it is declared per source in `FDA_SOURCES.postableGrades` rather than
decided inside the scorer.

## Grouping

The same trap as drug, worse: 307 food records over 61 days collapse to 123
groups, a 60% reduction. One event carried 23 records.

`classification` varies inside an `event_id` in ~9% of multi-record food
events and `reason_for_recall` in ~25%, which is why the key is the composite
and not `event_id` alone. See `2026-07-28-fda-event-grouping` reasoning in
PR #58.

## Quota

openFDA rate-limits per IP and Cloudflare egress IPs are SHARED across the
platform, so a burst from any Worker counts against us. A 429 is treated as a
soft failure, not a broken source, exactly as the drug job does.
