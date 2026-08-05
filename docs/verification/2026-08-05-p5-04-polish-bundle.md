# p5-04 verification: the polish bundle

**Verified:** 2026-08-05 UTC against the live `skeptic-wire` D1 database
(`d951177f-e4ab-4b6b-a014-efc7d78d065e`).

Four items from the plan: the `"Announced by X, per X"` join, raw ISO
timestamps in copy, the PRODUCT_RECALL length window, and the `over_budget`
split. All four found in live production data rather than reasoned about.

## 1. The attribution join stated the source twice

Real pending drafts, read from production:

```
'Sources of Changes in Current Account Balances (Projections for Aug.).
 Announced by Bank of Japan, per the Bank of Japan'

'Federal Officials Announce Major Arrests in International Drug Smuggling Case.
 Announced by DOJ, per the Justice Department'
```

`reg.authorityFirst` built `{title}. Announced by {authority}`, and render.ts
then appends the resolved attribution to the head line, so the source landed
twice.

**Fixed** by removing the restatement, not the attribution. The skeleton still
*gates* on `authority` (it is only offered for items that have an attributable
source, which is what makes the appended citation correct); it just stops
printing it a second time.

## 2. Raw ISO timestamps reached copy-ready text

This is the item that mattered most, because it was live rather than
theoretical. A production draft, copy-ready:

```
'Bank of Japan: Bank of Japan Accounts (July 31), per the Bank of Japan

 Published 2026-08-04T01:00:00.000Z.'
```

The p4 session predicted this as "exit #2" of the ISO defect but had not
observed it. The template engine does not run `numberCheck` at enqueue, so
when generation falls back to the template this string is what the owner is
handed to paste.

**Two beats, not one.** The prior analysis named `reg.dateStamped`. Grepping
for ISO slots found a second with the identical defect:

```
archetypes.ts:646  "Initiated {initiatedIso}. Published {reportedIso}."   (recall.lag)
archetypes.ts:891  "Published {publishedIso}."                            (reg.dateStamped)
```

**Fixed on the draft side**, which is where the prior analysis established the
fix belongs: CLAUDE.md mandates ISO-8601 storage because four feed dialects
arrive in four conventions, so changing what is stored would trade a real
invariant for a symptom. `fillSlots` gains a `{field:date}` format rendering
the stored UTC timestamp as `August 4`.

**persona.md agrees, and that is the strongest evidence the fix is correct.**
The owner-signed voice authority specifies these beats as:

```
line 202  `Initiated {d1}. Published {d2}.` [both dates parsed from the record]
line 252  `Published {date}.` [publication timestamp parsed]
```

A human date is what the doc asked for all along. The raw ISO was an
implementation choice in the field naming, never signed-off text. The
persona-parity test already normalised `{publishedIso}` to `{date}` before
comparing, so the doc side needed no change at all.

**Verified against the validator rather than assumed.** The p4 session asserted
that `"Published August 1."` would pass. That is now checked:

- `payloadFacts` stores both `8-4` and `2026-8-4` for a `publishedIso` of
  `2026-08-04T01:00:00.000Z`
- `dateCheck` accepts a month-day with no year
- `numberCheck("Published August 4.", payload)` returns `[]`
- `numberCheck("Published August 5.", payload)` still returns a `number` issue

So the change removes a slot without widening what a draft may claim.

UTC formatting is deliberate: stored timestamps are UTC by the same CLAUDE.md
rule, and formatting in local time would silently shift the printed day for
anything published near midnight.

## 3. PRODUCT_RECALL could not render at all, measured

```
SELECT COUNT(*), SUM(LENGTH(factLine)<=280), SUM(LENGTH(reason)<=120),
       MIN(LENGTH(reason)), MAX(LENGTH(factLine))
FROM items WHERE category='recall' AND reason IS NOT NULL;
-> total 100 | factline_fits 65 | reason_le120 67 | min reason 14 | max factLine 623
```

FDA `reason` strings run **14 to 454** characters and `factLine` to **623**,
against a 280 post budget. Thirty-five of 100 cannot render `recall.full`, and
the long-reason ones blew `recall.firmFirst` too, leaving the archetype with no
shape and reporting `over_budget`.

**Fixed with a window, not a truncation.** `recall.firmFirst` includes the
reason only when the finished head line still fits, and omits it whole
otherwise. A half-sentence FDA reason ("...due to undeclared") reads as a
different claim from the one the agency made, which is the fabrication class
this repo has closed twice. Dropping it states less; truncating it states
something else.

The budget is computed rather than reserved: PRODUCT_RECALL's attribution is a
fixed string, so the exact finished line is measured against `POST_TEXT_LIMIT`
instead of approximated with a guessed allowance.

## 4. over_budget was two different problems wearing one name

`render.ts` returned `over_budget` whenever no skeleton was chosen. But a
candidate can also be skipped by the BLENDING GUARD, which rejects a fact block
containing a blank line. If *every* candidate was skipped that way, the failure
was still reported as `over_budget`.

That reason reaches the owner directly, in the alert at `generate.ts:458`. So a
payload with a stray blank line sent the owner to trim text that was never too
long.

**Split** into `over_budget` (candidates were tried and none fitted) and
`blocked_blending` (no candidate was even eligible). Both are pinned by tests.

## 5. Deliberately NOT fixed: factLine's triple mention

```
'Bank of Japan: Bank of Japan Accounts (July 31), per the Bank of Japan'
```

`reg.headline` renders `factLine`, which the ingester builds as
`"{authority}: {title}"`, so the authority appears three times once attribution
is appended.

**Owner ruled to keep this chunk minimal.** Fixing it means either changing the
ingester's `factLine` or teaching the render join that a head line may already
name its source, and the second is a change to how attribution attaches
(persona.md section 6) rather than a polish fix. Recorded as D-15 in the
ledger, not silently dropped.

## 6. Tests

Nine added.

In `templates.test.ts`:
- `{field:date}` renders a human date; the plain `{field}` form is untouched
- an unparseable value or unknown format renders **nothing**, so a formatter
  typo drops the beat instead of falling back to the raw ISO it exists to remove
- **no live beat can emit a raw ISO timestamp**, asserted as a property over
  every beat in the registry rather than by naming the two known offenders,
  because the two were themselves found by a grep that a third could evade
- REGULATORY_NEWS no longer contains "Announced by" while still carrying its
  citation
- a long FDA reason is omitted whole (not truncated) and the post still fits; a
  short reason still rides
- `over_budget` and `blocked_blending` are returned for their own causes

In `ragValidate.test.ts`:
- `"Published August 4."` passes `numberCheck`
- `"Published August 5."` is still refused
- the month-day form is genuinely derived from the payload's own timestamp

Suite: **1,033 passing**, 1 pre-existing failure (D-6, red on main).
