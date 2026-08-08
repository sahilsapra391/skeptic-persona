# p6-01 — the B-12.4(b) acceptance measurement

Date: 2026-08-07. Chunk: p6-01 (revised under B-12). Gate: B-12.4(b).

## What was measured, and against what

**607 distinct EDGAR CONFORMED reporting-person names**, harvested from the
`(Reporting)` entry titles of the live `getcurrent` ATOM feeds for form types
4, 4/A, 144, 144/A and 3 on 2026-08-07 (declared UA, sequential, <7 req/s).
Corpus committed at [2026-08-07-p6-01-conformed-corpus.txt](2026-08-07-p6-01-conformed-corpus.txt).

The `(Reporting)` title **is** EDGAR's conformed name for that CIK, which is
the independent authority B-12.2 now requires. It is not a larger sample of the
document text that produced the original error.

Every output was classified into exactly one of three buckets by comparing
token sequences, case- and punctuation-insensitive, with suffix and credential
PLACEMENT normalised away on both sides (the module always renders those last,
while EDGAR conforms them mid-string — `Zemaitatis Jr. Stephen M`).

- **flipped correctly** — the output is a rotation of the conformed token
  sequence, i.e. a leading surname block moved to the end.
- **suppressed** — the output preserves the conformed order (or is a prefix of
  it, for an entity whose boilerplate tail was trimmed).
- **neither** — anything else. A permutation that is not a rotation is a name
  the record does not support.

## Results

```
total                       607
flipped correctly           514   (84.7%)
suppressed / order kept      93   (15.3%)
  of which entities          76         correctly never reordered
  of which PERSONS           17         ugly-but-true, the blind spot
NEITHER (gate: must be 0)     0
derivability failures         0
```

**The gate is met: zero outputs are neither the filed order nor a correct
reordering, and zero outputs contain a token absent from the filed name.**

## The 17 suppressed persons, in full

B-12.4(b) asked for a sample to eyeball. This is not a sample, it is all of
them — 2.8% of the corpus.

```
Bar-Nathan Abudi Jacob            Harari Eyal David
Brau Donnelly Julia               Helgren Erin Claire
Chadwick Shelly Marie             Martin Karen Lynne
Chan Kin Kenneth                  Mat Ishbia
Conder Keenan Michael             Oxnard Geoffrey Raymond
Cui Jingrong Jean                 Riese Phillip John
Dei Cas Katherine                 Solomon Darlene J. S.
Dos Santos Cardoso Joao Kleber    GRAYSON BLAKE JEFFREY
```

They split three ways:

- **Correctly suppressed.** `Dei Cas Katherine` (Katherine Dei Cas),
  `Brau Donnelly Julia`, `Bar-Nathan Abudi Jacob` — genuine two-word surnames,
  the exact shape B-12.4(a) exists for. `Mat Ishbia` is already natural order.
  `Dos Santos Cardoso Joao Kleber` is five tokens, outside the person bound.
- **Over-suppressed.** `Chadwick Shelly Marie`, `Chan Kin Kenneth`,
  `Conder Keenan Michael`, `Cui Jingrong Jean`, `Helgren Erin Claire` and the
  rest would have flipped correctly, but the given name at position 1 is
  missing from the list so the ambiguity rule could not clear them.
- **`Solomon Darlene J. S.`** — two trailing initials; the module declines
  rather than guessing which is the middle name.

Every one of them renders in EDGAR's filed order. None renders as a name the
filing does not contain. That is the designed outcome, not a failure
(B-12.4a), and the over-suppressed group shrinks as the given-name list grows
without ever being able to grow the invented-name count, because the list can
only withhold a flip.

## The invariant

`deriveDisplayName` checks `displayIsDerivable` on its own output before
returning and falls back to the cased filed string if it ever fails. Every
letter-or-digit run in a display must trace to one in the filed name, so no
branch — flipping, suppressing, entity-trimming or credential-casing — can emit
a token the filing did not contain. It caught one real case during the build:
canonicalising `M.D.` to `MD` merges two runs into one, so a dotted credential
now keeps its dots.

`displayIsDerivable` itself was ASCII-only (`/[A-Z0-9]+/`) and returned true
for `("Smith John", "Иванов Иван")`. It is Unicode-aware now, with that case
pinned as a regression test.

## Reproducing

Harvest with `(Reporting)` titles from the ATOM feeds and re-run the
three-bucket classification. The corpus file is committed so the numbers above
can be re-derived exactly without another fetch.
