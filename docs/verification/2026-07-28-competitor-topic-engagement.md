# Competitor topic engagement — measurement record

**Measured:** 2026-07-28
**Corpus:** 33,323 unique posts across 5 accounts (unusual_whales, Heisenberg,
spectator_index, evan_stockmktnewz, amit_is_investing); TOP + LATEST exports
scraped 2026-07-26. Source files live OUTSIDE the repo at
`~/Documents/Projects Misc/Skeptic/x persona/x persona scrapped tweets/`
and are deliberately not committed: no third-party text in the product.
**Method:** median `favorite_count` of keyword-matched posts, divided by that
same account's own median across all its non-reply posts. Ratios suppressed
where n < 25.

---

## WARNING: do not use pooled ratios

Account baselines differ by roughly 10x (Heisenberg median 284 likes,
spectator_index 2,765). Any topic dominated by a high-baseline account gets an
inflated **pooled** ratio that measures *which account posts it*, not how the
topic performs. This is Simpson's paradox, and it reverses at least one
conclusion outright.

Worst case:

| geopolitics | ratio | n |
|---|---|---|
| **pooled** | **1.70x** | 4,473 |
| Heisenberg | 1.28x | 151 |
| spectator_index | 1.13x | 1,843 |
| evan_stockmktnewz | 1.02x | 81 |
| amit_is_investing | 0.94x | 300 |
| unusual_whales | 0.93x | 2,098 |

Every individual account sits at or near its own baseline. The pooled 1.70x is
pure composition: 3,941 of the 4,473 geopolitics posts come from the two
highest-baseline accounts. Taken at face value it ranks geopolitics as the
single best topic available, and would steer selection into the late,
undifferentiated, wire-copy-sourced headline lane that editorial judgment had
independently rejected. The per-account view agrees with the editorial call;
the pooled view contradicts it.

Same distortion, smaller magnitude, on congress_ptr (pooled 1.80x vs
unusual_whales 1.67x, with spectator 0.90x and amit 0.96x) and on enforcement
(pooled 1.57x vs 1.13x).

**Use per-account ratios, n >= 25 only.**

---

## Operative table

| topic | unusual_whales | other accounts (n >= 25) | read |
|---|---|---|---|
| congress_ptr | **1.67x** (253) | spectator 0.90x, amit 0.96x | clear winner |
| options_flow | 1.17x (169) | — | barely above baseline |
| enforcement | 1.13x (124) | — | marginal |
| insider_form4 | 1.06x (78) | amit 1.13x, Heisenberg 1.00x | marginal |
| macro_print | 0.84x (339) | spectator 0.61x, amit 0.94x | underperforms |
| price_tape | 0.68x (297) | Heisenberg 1.07x, evan 1.08x | underperforms |
| rate_decision | **0.56x** (69) | amit 0.93x | weakest measurable topic |
| halt | n < 25 everywhere | — | unmeasurable |
| fda_recall | n < 25 everywhere | — | unmeasurable |

The trustworthy part is the **relative ordering** (congress > insider ~
enforcement > macro > rates), not the coefficients.

Two findings worth stating plainly:

- **`options_flow` at 1.17x is the cleanest vindication of BLOCKED-VENDOR in
  the dataset.** That is unusual_whales' own paid product, on their own
  account, barely beating their own median. The market data we cannot legally
  license is not costing us much.
- **`rate_decision` at 0.56x is the weakest measurable topic**, which is worth
  knowing right after shipping seven central banks. The declarative rate
  framework earned its place by making each additional source nearly free, not
  by making each source individually strong. Expansion stopped here.

---

## Coverage: the whitespace finding

Of 19,518 usable posts (text-only, <= 280 chars, no media, not a reply),
counts matching each archetype Skeptic actually ingests:

| archetype | posts across all 5 accounts |
|---|---|
| congress / PTR | 154 |
| rate decision | 70 |
| halt | 38 |
| insider / Form 4 | 27 |
| FDA recall | 10 |
| 8-K / filing | 4 |
| Treasury auction | 2 |

Four of the five accounts essentially never touch the filing-shaped catalogue.
Two consequences, both acted on:

1. **Depth in filings beats breadth in headlines.** Ingestion queue reordered
   to EDGAR daily-index reconciliation, Form 25, Reg SHO, FINRA short interest.
2. **Style-exemplar retrieval over this corpus is not viable.** Masking every
   post to a sentence skeleton (content tokens replaced by `<NUM>`, `<ENTITY>`,
   `<TICKER>`, `<CAPS>`) collapses 19,518 posts to **19,184 distinct shapes**.
   Only 55 recur three or more times, and those are gold-price and GDP-table
   posts. A retrieval step filtered to archetype would return 2 records for a
   Treasury auction and 4 for an 8-K, then silently fall back to the wrong
   shapes — an invisible failure, which is the kind this project designs
   against. Hence the static hand-distilled style pack and no vector index.

The one exception is congressional PTR at n=154 (135 of them from
unusual_whales), which is simultaneously the best-measured topic, the only
archetype with real style coverage, and the archetype persona.md section 7
already names as the signature. The style pack is built congress-first for
that reason.

---

## Caveat that bounds all of the above

These are priors from accounts with 0.5M–4.8M followers whose audiences were
already selected for their topic mix. Ratios transfer directionally, not
numerically: 1.67x on unusual_whales' congress audience is not a promise of
1.67x on ours. Treated as a tie-breaker on ordering, never imported as
coefficients.

The number worth hard-coding later is our own, once `post_log.final_text`
capture has accumulated volume.

---

## Reproduce

Keyword bank, per-account baselines, and every cell including suppressed ones
are regenerated by running the method above against the five source exports.
Baselines at time of measurement: Heisenberg 284, amit_is_investing 1,576,
evan_stockmktnewz 1,342, unusual_whales 1,739, spectator_index 2,765.

---

## Addendum (2026-07-28, style-pack distillation): the congress coverage is thinner than the topic count

The 154-post congress figure above counts topic mentions. Isolating posts that
are actually TRADE-DISCLOSURE shaped (member + trade verb or disclosure
mechanics, text-only, <= 280 chars) leaves **13 posts, all from one account**,
and they share a single shape: alarm opener ("BREAKING:"), an editorial frame
line ("Look at this." / "This is unusual."), then member + verb + amount +
ticker + date, occasionally with a temporal-proximity clause joining the trade
to an outside event.

Consequences for the style pack (src/rag/stylepack.ts):

- "Congress-first" holds for the archetype, not for exemplar volume. The
  measured section distils structure and register statistics (52% ALL-CAPS
  openers, 40% BREAKING across the 175 topic posts), not retrieved examples.
- The engagement driver in every high performer is temporal proximity. The
  doctrine-legal subset is exactly the case where both dates are parsed:
  trade date vs disclosure date — which is what the existing lag beats
  already are. Proximity to an UNPARSED outside event ("before the strike")
  is catalogued in the anti-corpus as the manufactured-connection pattern.
- An offline 8-gram sweep of the style pack against all 33,323 corpus posts
  returned zero collisions (1,577 pack 8-grams checked). Re-run on any edit
  to the pack; the method is in the PR that added it.
