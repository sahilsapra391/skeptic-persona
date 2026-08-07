# 8-K item 2.02 to periodic-XBRL lag — measurement record (B-04.4)

Measured 2026-08-07 against live `data.sec.gov/submissions/`, declared UA,
under 10 req/s. Supersedes the two earlier readings, **both of which were
wrong**, and the reasons are worth keeping because they were different reasons.

## The two bad readings

**Reading 1 (right-censored).** Sampled 8-Ks filed "recently", including ones
filed the same day. 8 of 14 had no periodic yet, not because the lag was long
but because the future had not happened. Reported as a mean.

**Reading 2 (mispaired).** Re-run on a closed window, and reported as bimodal:
7 of 10 same-day, 3 at 69-87 days. The long arm was **entirely an artifact of
the matcher**, and the small sample made the same-day fraction look far more
dominant than it is.

The matcher paired *the most recent 8-K before date D* with *the next 10-Q
filed after it*. Both halves are wrong. Checked against SEC submissions:

| Company | Reading 2 said | Actually |
|---|---|---|
| Mastech Digital | 8-K 05-18 → 10-Q 08-06, **80d** | 8-K **05-15** → 10-Q 05-15, **0d** |
| Airship AI | 8-K 05-11 → 10-Q 08-06, **87d** | 8-K 05-11 → 10-Q **05-08**, **−3d** |
| Montauk Renewables | 8-K 05-28 → 10-Q 08-05, **69d** | 8-K **05-06** → 10-Q 05-06, **0d** |

Mastech filed **no item-2.02 8-K on 05-18 at all**; the matcher took an
unrelated 8-K and reached forward a whole quarter. Airship's periodic was filed
**three days before** its 8-K, which order-based matching cannot represent, so
it also reached forward a quarter.

## The fix

`src/pipeline/earningsResults.ts`. Two rules:

1. **Match on the specific 2.02 accession.** An 8-K without item 2.02 is not an
   earnings announcement and has nothing to pair.
2. **Match on period, not filing order.** The periodic belonging to an earnings
   8-K is the one whose *period end* is the latest period ending at or before
   the announcement, bounded by `MAX_PERIOD_AGE_DAYS = 120`.

The field trap underneath: in submissions JSON, `reportDate` is the **period
end** on a 10-Q/10-K and the **event date** on an 8-K. They are never compared
as like quantities.

## The clean measurement

60 CIKs drawn from our own lake (every CIK with a 2.02 8-K), events filed
2026-01-01 to 2026-06-15 so every period had time to close.

```
n=122 pairs   unpaired=0   CIKs sampled=60
min=-3  p25=1  p50=10  p75=25  p90=44  max=70
same-day (lag 0)       : 21/122  (17%)
periodic FIRST (lag<0) :  3/122  ( 2%)
within +/-3 days       : 45/122  (37%)
```

**Not bimodal. Continuous and right-skewed.** Median 10 days.

### The split that actually matters

```
10-Q : n=64  p50= 6d  p75=11d  max=29d   same-day-or-earlier 16/64 (25%)
10-K : n=58  p50=28d  p75=39d  max=70d   same-day-or-earlier  8/58 (14%)
```

**Quarterly XBRL arrives roughly 4.7x faster than annual** at the median. The
same companies show it internally, which is what makes it a real effect rather
than a sampling artifact:

```
FIRST CAPITAL INC        10-Q 18d   10-K 67d
Baker Hughes Co          10-Q  1d   10-K 10d
LAKELAND FINANCIAL CORP  10-Q  2d   10-K 30d
HBT Financial, Inc.      10-Q  9d   10-K 39d
Ponce Financial Group    10-Q 13d   10-K 45d
ALLIANCE RESOURCE PTRS   10-Q 11d   10-K 24d
```

Annual results get announced well before the 10-K is assembled; quarterly
results frequently ship alongside the 10-Q.

## What this means for B-01.6

1. **A single freshness window cannot serve both forms.** Anything tuned to the
   10-Q median (6d) strands most annual results; anything tuned to the 10-K
   median (28d) holds quarterly results weeks past their news value. The window
   is per-form or it is wrong.
2. **The trigger must not assume the periodic follows the event.** 3 of 122
   pairs have a negative lag. A trigger that only watches for periodics
   arriving *after* a carded 8-K silently drops those.
3. **Same-day is common but not the norm.** 17% at exactly 0, 37% within three
   days. Reading 2's "usually same-day" claim was small-sample noise.
4. **A result can be genuinely unavailable for a long time and that is normal.**
   The p90 is 44 days. Absence of XBRL is not a parse failure.

## Honest bounds

The 60 CIKs are whatever our lake happened to have carded, which skews toward
issuers that pass the existing issuer gate; financials are visibly
over-represented. It is a sample of *our* universe, which is the relevant one
for trigger design, but it is not a random sample of all filers. Sample rows
and the exact script are in the session scratchpad; the pairing logic under
test is the shipped `earningsResults.ts`, not a copy that could drift.
