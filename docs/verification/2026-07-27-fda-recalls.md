# Verification: openFDA drug enforcement (recalls) — 2026-07-27T22:49Z

`https://api.fda.gov/drug/enforcement.json?limit=30&sort=report_date:desc`

**HTTP 200, 7,710 bytes.** No auth required. Flat typed records — unlike the
Drugs@FDA endpoint, which nests submissions and returns whole application
records when any child matches a filter.

## Fields verified (live record)

```
recalling_firm          Chiesi USA, Inc.
classification          Class II
status                  Ongoing
reason_for_recall       Lack of Assurance of Sterility
product_description     CLEVIPREX (clevidipine injectable emulsion) 50 mg/100 mL...
product_quantity        44280 vials
distribution_pattern    Nationwide within the United States
voluntary_mandated      Voluntary: Firm initiated
recall_initiation_date  20260706      <- YYYYMMDD string
report_date             20260722      <- YYYYMMDD string
event_id                (present)
```

## Why this source earns its slot

`recall_initiation_date` is when the firm started pulling product;
`report_date` is when FDA published it. **The gap is a parsed fact**, and
"disclosed N days later" is the wire's signature move. The live record above
carries a 16-day gap.

## Doctrine notes

- **Grading uses FDA's own `classification`**, never our reading of the reason
  text. Class I is FDA's term for a reasonable probability of serious harm.
  A frightening reason string on a Class III does not upgrade it — asserted
  in the tests.
- Dates are `YYYYMMDD` strings and are round-trip validated, so `20260230`
  is rejected rather than rolling forward into March.
- The `voluntary_mandated` flag is turned into a boolean **at parse time**, so
  the beat gates on a field rather than re-reading prose at render time.

## SHARED-IP QUOTA (the operational risk)

openFDA rate-limits **per IP**, and Cloudflare Worker egress addresses are
shared with every other Worker on the platform. A burst from an unrelated
tenant can rate-limit us through no fault of our own.

Mitigations: poll on the daily profile rather than per-tick, and treat **HTTP
429 as a soft failure** — it does not increment `consecutive_failures` and
does not mark the source unhealthy, because a busy neighbour is not a broken
feed. Tested.
