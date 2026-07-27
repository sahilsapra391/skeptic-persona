# SKEPTIC WIRE — Persona & Voice Doc (v1, owner-signed 2026-07-27)

Owner-authored pass applied 2026-07-27. This document governs every word the
account publishes. Templates (PR-8+) are written against it; any conflict
between a template and this doc is a bug in the template.

## 1. Identity

Skeptic's market desk. Not a person, not a robot character: a desk with a
worldview, run by the team behind skeptic.fyi. It reads primary sources so
you don't have to, and it publishes evidence, not takes. The personality is
real because the writing is good and a real person operates it, never
because it pretends to be someone.

## 2. Worldview (the spine)

- Claims need evidence. A filing is evidence. A vibe is not.
- Timing beats narrative. The narrative shows up after the move and takes
  the credit.
- Most "edges" are someone reading a public document first.
- Quietly pro-retail. The skepticism aims at power and hype, evenly.

## 3. The structural law (non-negotiable)

**Fact first, beat last, never blended.** Every data post is
`[parsed fact + attribution]` then optionally ONE dry beat on its own line.
The fact must survive being screenshotted alone, because wire posts get
shared as evidence and an op-ed can't be evidence.

Escalation rider: when the record itself is absurd, the beat may be sharper,
but it still states only what the record shows.

## 3b. The craft principle (owner-authored)

**The reader finishes the sentence.** We hand them the parsed fact that
makes the thought unavoidable, and stop. That is the mechanism for
bold-without-imputing: the desk says what everyone's thinking by stating
the fact they're thinking it about.

## 4. Bio

Owner-set, live on the profile. Register on record: brand-affiliation
transparent (skeptic.fyi visible), no machine language, no fake-human
framing. Any future bio edit stays inside that register.

## 5. Policy floor (non-negotiable)

Never deny automation if directly asked; the true answer is "Skeptic's
desk, a human runs it," and one does. Never fabricate an individual human
identity: no fake name, no fake human avatar, no personal-life lore; the
avatar is the brand mark. The skeptic.fyi affiliation stays visible. Every
pilot post is human-approved and all replies are human-written.

## 6. Register rules

Wire-terse or explainer-long, nothing in between. Median volume post
~100–140 chars. No hashtags, no engagement-bait questions, no fake urgency,
no "BREAKING" on routine items. No em-dashes in post copy. Emoji only
purposeful: 🟢🔴 for tape, flags for countries, nothing decorative.
Attribution on every fact: per SEC, per Senate eFD, per Nasdaq, per BLS,
per Skeptic's tape. Advice language never: no buy/sell/watch/avoid, no
targets, no "bullish/bearish."

## 7. Selection as opinion

The worldview's loudest expression is WHAT gets posted, not how it's
phrased. Standing scoring bias: over-weight congressional trades,
populist-econ stats, disclosure-lag stories, and suspicious-timing filings
where the timing itself is a parsed fact. (Implemented as scoring weights;
spec'd into the next tuning PR.)

## 8. Beat libraries

Format: beat text, then [gate] — a machine-checkable condition on parsed
fields. A beat with an unmet gate never renders. Rotation is mandatory:
consecutive posts of one archetype never reuse a beat (Meta names
repetitive content as a spam signal).

### 8-K FILING ALERT
- `Non-reliance is the accounting version of a retraction.` [4.02]
- `Prior financials can't be relied on. That's the filing's own claim.` [4.02]
- `Delisting notice, not a delisting.` [3.01]
- `Choosing 1.05 is itself the materiality call.` [1.05]
- `Item 5.02 covers exits and arrivals. The title is doing a lot of work.` [5.02]
- `Bankruptcy is the one item that never needs translating.` [1.03]

**Escalation tier** (absurd-case gates):
- `Second non-reliance this year.` [REQUIRES lookback query: both filings
  parsed and in our lake — not enabled until the lookback lands]
- `Same item, new quarter.` [same lookback requirement]

### FORM 4 / INSIDER
- `Code P. Bought, not granted.` [open-market buy]
- `{lag} days from trade to filing.` [both dates parsed, lag ≥ 2]
- `The stake number is the filer's own.` [sharesAfter parsed]
- `An award is compensation. A P is a decision.` [P present]

### INSIDER CLUSTER
- `{n} separate filings, same issuer, same week.`
- `Buys only. Code P across every filer.`
- `Seven calendar days, not seven sessions.`
- `{n} signatures, not one.`
- `The cluster is the fact. The reason isn't filed.`

**Escalation tier:** cluster-plus-tape coincidences (both facts parsed)
are reserved for P5 when Skeptic's own tape data joins the lake. No market
prices exist in the pipeline today, so no such beat may render yet.

### CONGRESSIONAL PTR (the signature)
- `Disclosed {lag} days later.`
- `The lag is the product.`
- `Reported as a range. That's all the record shows.`
- `Trade date {d1}. Public {d2}.`
- `Paper filing. Scanned, technically public.` [paper kind — CURRENTLY
  DISABLED: paper PTRs score log-only and never reach the queue. Promoting
  them is an owner call.]

**Escalation tier:**
- `Read that lag again.` [lag ≥ 30 days]
- `Filed eventually.` [lag ≥ 40 days]
- `The range is doing a lot of work.` [band WIDTH ≥ $1M, e.g.
  "$1,000,001 - $5,000,000". NOT a ratio: the minimum reportable band
  "$1,001 - $15,000" has the highest ratio in the Senate table (15x) and is
  the most routine disclosure there is.]

### BLS PRINT
- `Core above headline this month.` [both parsed, SIGNED core > SIGNED headline — comparing magnitudes would let core -0.6 read as "above" headline +0.5]
- `One month of data. The y/y line covers twelve.`
- `Headline only. The rest is in the release.` [numbers partially parsed]

**Escalation tier:**
- `The release's words: {superlative}` [gate: superlative sentence parsed
  from the release text] — quotes the release's OWN superlative when it
  prints one, e.g. "largest 1-month decrease since April 2020". The
  government writes the beat; we only carry it.

### FED / STATEMENT DIFF
DISABLED UNTIL BUILT: these describe a diff between consecutive FOMC
statements, and the diff engine is P3. Fed press releases post the Fed's own
headline with no beat until then.
- `The edit is the entire news.`
- `Everything else is verbatim.` [diff confirms remainder identical]
- `The diff will not change. The interpretations will.`
- `Punctuation counts here too.` [punctuation-level change]
- `Adjectives are load bearing in this document.`

### HALT
- `Pending is the whole disclosure.` [T1]
- `The band did what the band does.` [LUDP/LUDS]
- `The code is the whole story so far.`
- `Past this line it would be guessing.`

**Escalation tier:**
- `Halt number {n} for this symbol today.` [≥3 halts on the symbol with the
  same reason code inside 24h, counted from our own lake. Repeats below that
  bar are suppressed to log-only: a stock tripping LUDP every few minutes is
  ONE story, not eight (WLDS halted 8x in an hour on 2026-07-27 and the
  account posted two of them ten seconds apart).]

### TAPE CHECK (our own data; cited "per Skeptic's tape")
- `Shelf life measured in hours.` [0DTE share elevated]
- `That is one day of tape.`
- `Regime is a label we put on a number.` [GEX flip]
- `A ratio does not know what happens next.` [put/call]

**Owner signature (rare, by design):**
- `The casino is the market now.` [GATE: record/extreme print only, e.g.
  0DTE share at an all-time high in our lake. Fired rarely it hits like a
  verdict; daily it's a catchphrase. Never in normal rotation.]

## 9. Personality slots (full voice, approval-gated, owner authors finals)

### MUSING (max 2/day, lowercase ok, zero numbers, zero named parties)
Seed themes (owner rewrites in his own hand):
- `a backtest is a story told by someone who already knows the ending.`
- `the narrative shows up after the move and takes the credit.`
- `most edges are just someone reading a public document first.`
- `a screenshot of a p&l is not evidence of a method.`
- `stare at anything long enough after midnight and it turns into a pattern.`
- `the market is a machine for making hindsight feel like foresight.`
- `everyone's a genius until the filing drops.`
- `diversification is admitting you don't know. that's why it works.`

### NIGHTLY RITUAL — "Today's verdict:" (Format C, THE LEDGER — owner-picked)
Same time every trading day. Grades DISCLOSURE FLOW, never price. Grade
line on top so the opinion leads; fixed rows every night; an empty row
reads `none on the feed`, never "nothing happened" (absence in our lake is
not absence in the world).

```
Today's verdict: <grade line>.

Halts: <n or none on the feed>
Insiders: <n>
Congress: <n>
Macro: <print or none scheduled>

Per SEC, Nasdaq, Senate eFD, BLS.
```

Grade-line vocabulary (rotating): `Busy on paper, thin on news.` /
`One real story and a lot of paperwork around it.` /
`Loud early, procedural by the close.` / `Normal, if you grade on volume alone.`

### EXPLAINER (big-move triggered)
CAPS headline → 3–5 parsed facts, one per line, each attributed → one
closer that refuses to extrapolate:
`That's the entire public record so far.` / `No reason appears in the
document.` / `What happens next isn't filed yet.` / `Facts above.
Narrative not included.`

## 10. Replies

Human-written, always. In-voice: cite the filing, concede good corrections
fast, never fight, never predict, never advise. The desk is allowed to say
"we don't know."

## 11. Consolidated never-list (what makes bold sustainable)

Never impute knowledge or motive ("they knew", "conveniently",
"coordinated", "quietly filed"). Never assert absences we didn't parse.
Never streaks or records without a queried lookback. Never numbers in
beats that aren't in the payload. Never advice, targets, or direction.
Never explain our own speed or tooling in-voice. Never deny automation if
asked. Never midpoints for congressional bands. Never a beat on an
amendment.
