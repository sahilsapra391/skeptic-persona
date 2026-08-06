# Exemplar payload pack: EARNINGS_EVENT (p5-20)

**For owner drafting.** Four real item-2.02 filings from 2026-08-06, with every
field the model and the card can see. Nothing here is synthetic.

**The constraint that shapes the voice:** there is no earnings figure in any of
these payloads, and there never will be. Item 2.02 announces that results were
released; the numbers live in the attached press release, which is prose, and
this desk does not extract numbers from prose. A draft that states EPS, revenue,
a beat or a miss is rejected the same way an unlicensed number is.

What the desk *has* is speed and provenance: the filing exists, here is who,
here is when, here is the link. That is the whole hand.

---

## 1. `$WHWK` — Whitehawk Therapeutics, small

```json
{
  "company": "Whitehawk Therapeutics, Inc.",
  "cik": "0001422142",
  "formType": "8-K",
  "filedIso": "2026-08-06T14:08:06.000Z",
  "displayName": "$WHWK",
  "tickerResolved": true,
  "exchange": "NASDAQ",
  "sizeTier": "small",
  "publicFloat": <on file>,
  "periodLabel": null
}
```
salience **50** · [filing](https://www.sec.gov/Archives/edgar/data/1422142/000119312526337069/0001193125-26-337069-index.htm)

Template draft, 121 weighted:
> $WHWK filed its results with the SEC on August 6, per SEC
>
> The numbers are in the issuer's own release, not in this post.

---

## 2. `$YORW` — YORK WATER CO, accelerated

```json
{
  "company": "YORK WATER CO",
  "cik": "0000108985",
  "displayName": "$YORW",
  "sizeTier": "accelerated",
  "filedIso": "2026-08-06T13:32:21.000Z",
  "periodLabel": null
}
```
salience **58** · [filing](https://www.sec.gov/Archives/edgar/data/108985/000010898526000070/0000108985-26-000070-index.htm)

---

## 3. `$MHH` — Mastech Digital, **unmeasured** size

```json
{
  "company": "Mastech Digital, Inc.",
  "cik": "0001437226",
  "displayName": "$MHH",
  "sizeTier": "unmeasured",
  "publicFloat": null,
  "filedIso": "2026-08-06T13:30:16.000Z"
}
```
salience **50** · [filing](https://www.sec.gov/Archives/edgar/data/1437226/000119312526337015/0001193125-26-337015-index.htm)

Template draft, 126 weighted:
> 8-K, Item 2.02: $MHH released results, filed August 6, per SEC
>
> The numbers are in the issuer's own release, not in this post.

**This is the case worth a look.** 45.6% of issuers have no public float on
file. They are unmeasured, not small, and they card normally. If you want the
voice to acknowledge that at all, say how; the payload knows the difference and
currently the copy does not.

This filing also carried items 5.02 and 5.03 alongside 2.02 — an officer or
director change filed with the results. The lane routes on 2.02 and the other
items are in the payload but unused. **Owner call: is a same-filing officer
change worth a beat, or is that two stories in one post?**

---

## 4. `$BKV` — BKV Corp, accelerated

```json
{
  "company": "BKV Corp",
  "cik": "0001838406",
  "displayName": "$BKV",
  "sizeTier": "accelerated",
  "filedIso": "2026-08-06T13:18:39.000Z"
}
```
salience **58** · [filing](https://www.sec.gov/Archives/edgar/data/1838406/000162828026053966/0001628280-26-053966-index.htm)

Rendered at 56 weighted — fact block only, no beat, on this seed. Included
deliberately so you can see the short shape as well as the long one.

---

## What a draft may and may not say

**May:** the company (as cashtag when the CIK resolves, filed name when it
does not), that results were filed, the period *only* when the SEC states one,
the filing timestamp, the item number, the exchange, and a count of prior
same-item filings from that issuer this year when the lake actually holds them.

**May not:** any figure from the press release. Any characterisation of the
results — strong, weak, beat, miss, ahead, behind. Any market reaction. Any
company size in the copy (the float decides attention, never wording). Any
inferred period.

## The three questions this pack is asking you

1. **Voice for the "no numbers" move.** The current beat says *"The numbers are
   in the issuer's own release, not in this post."* It is honest and a little
   flat. It is also the line that will appear on every earnings card, so it is
   worth your hand.
2. **Unmeasured size** — worth acknowledging in copy, or invisible?
3. **Multi-item filings** — 2.02 plus 5.02 in one 8-K: one story or two?

Drafts back whenever. The lane ships without exemplars and falls back to
templates until they arrive; nothing here waits on you.
