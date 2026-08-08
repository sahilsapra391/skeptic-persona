# P6 plan corrections — A2's two wrong root causes (B-15.6)

The P6 program doc lives in ~/Downloads and is the owner's. These are the
corrections the repo owes it, recorded here so the plan's diagnosis and the
measured reality both stay on the record rather than the plan being quietly
worked around.

## A2, first wrong root cause: `cusip_map`

**The plan says.** Form 144 and 8-K "do not [carry a symbol], and they fall
through to the 87%-unmapped `cusip_map`."

**Measured.** Neither lane references `cusip_map` at all. `grep` returns zero
hits in `form144.ts` and `edgar8k.ts`. Form 144 attempted **no** resolution of
any kind, and `shared.ts` said so on purpose: *"deliberately excluded because
it parses no symbol at all... Named honestly so nobody later 'fixes' this into
$Company Inc."* That decision was correct about the DOCUMENT and wrong about
the pipeline, and it is overturned on the record in `form144.ts`.

`cusip_map` is the 13F lane's index, keyed on CUSIP. The insider lanes are
keyed on CIK and never touch it.

## A2, second wrong root cause: "ingest the SEC's own CIK-to-ticker file"

**The plan says.** "Ingest the SEC's own CIK-to-ticker mapping file [VERIFY the
current canonical URL...]."

**Measured.** We have ingested it since **2026-07-28**. `src/ingesters/
issuers.ts:26` fetches `company_tickers_exchange.json` and the table holds
8,056 rows, every one with a ticker. There was no ingest to build.

The real gap was narrower and the plan never named it: **two lanes never
looked**. That is a resolution-chain defect, not an ingestion one, and the fix
is ~110 lines in `src/lib/symbol.ts` rather than a new job.

## What the plan could not have known

Underneath the wrong diagnosis was a live defect neither the plan nor the
review had seen: the `issuers` upsert is keyed on `cik` while SEC's file is
one-to-many, so 1,452 CIKs were resolved by whichever row came last. **247
production rows held a preferred series, a warrant, a unit or a right** —
JPMorgan Chase resolved to `VYLD`. Routing Form 144 and 8-K through that table
without fixing the selection would have spread it to the primary lane. See
D-92 and D-93.

## The standing rule

**The plan is a hypothesis; production is the authority.** Two wrong root
causes in one plan section is not a criticism of the plan, which was written
from cards rather than from the code. It is the reason a chunk starts by
measuring the thing it is about to change.
