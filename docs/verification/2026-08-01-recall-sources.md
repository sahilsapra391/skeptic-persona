# Recall sources beyond food and drug — 6 probed, 1 adopted

**Verified 2026-08-01T23:2xZ**, declared UA (`Skeptic Wire admin@spechawk.ai`).

The desk already ingests openFDA **drug** (0018) and **food** (0041) recalls.
This pass asked what other recall authorities publish something a market desk
can cite. Six endpoints probed: openFDA device, CPSC, NHTSA (two shapes),
USITC, and the CPSC newsroom RSS.

## Adopted: openFDA device enforcement

`https://api.fda.gov/device/enforcement.json?limit=30&sort=report_date:desc`

**Field parity is exact.** Every field `parseRecalls` reads — `event_id`,
`recalling_firm`, `classification`, `reason_for_recall`, `report_date`,
`recall_initiation_date`, `product_description`, `product_quantity`, `status`,
`distribution_pattern`, `voluntary_mandated` — is present under the same name.
Three datasets, one parser, no parser change.

It also inherits the per-product flood. A 10-row capture holds **6 events**,
with Abiomed filing three rows for one recall. `groupRecalls` already handles
it; the test pins that it does.

### Class I only, and the count says so

Measured over `report_date:[20260501 TO 20260801]`:

| Class | Rows | Distinct events | Per month |
|---|---|---|---|
| Class I | 151 | 38 | ~13 |
| Class II | 640 | 200 | ~67 |
| Class III | 2 | — | — |

67 events a month is **double the food Class II rate that got food capped**,
and the queue already expires more cards than it approves. One firm, Medline,
is 189 of the 640 Class II rows on its own.

The severity split tracks the firms, which is the part that matters here.
Class I over that window is Arrow International, Abiomed, Becton Dickinson,
Medline and Argon Medical. Class II runs to calibration drift and labelling —
a real safety notice, not market intelligence.

**The grade is FDA's, and which grades are worth posting is ours.** That was
already the design; this source just supplies its own measurement for it.

## Rejected: CPSC consumer product recalls

`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=…`

This one returned 200, clean JSON, 55 recalls for July 2026, with a
well-structured record carrying `RecallDate`, `Title`, `URL`, `Description`,
`Manufacturers`, `Retailers`, `Importers`, `Hazards`, `Injuries` and
`RemedyOptions`. It looked like the obvious sibling to the FDA lanes.

It fails on what the fields actually contain.

**1. The unit count is not in the API.** CPSC's own recall pages carry "about
30,000 units". The API does not: **0 of 55** July descriptions matched a
units figure. The single most citable number CPSC publishes is absent from
the payload, and doctrine #1 means a post cannot claim it.

**2. `Manufacturers` is empty on roughly 60% of records** — 33 of the 55.

**3. The company fields that do exist are prose, not names.** A real
`Retailers[].Name` from the July window:

> "Online at Amazon.com from August 2024 through April 2026 for about $140."

That is a sentence. Gating on it would mean substring-matching issuer names
against free text, which for short names ("Gap", "Ford", "Target") is a
false-positive machine.

**4. Almost nothing is listed.** Across all 55 July recalls the recalling
parties are overwhelmingly small Chinese importers — Changzhou Jiaxuan
Intelligence Furniture, Xuzhou Mingquanhe Household, HuNanBoLuoDianZiShangWu.
Names a market desk could use: Target, Panasonic, TOMY, Conair, Cooper
Lighting, Galanz. **Three to five of 55, so a ~7% signal rate.**

Adopting it unglazed would put ~50 unknown-importer cards a month into
Telegram, which is precisely the failure the issuer gate was built to stop.
There is no cheap gate available, because the field an issuer gate would key
on is the one that is missing or prose.

**Recorded rather than deferred.** CPSC could be revisited if it ever exposes
a structured firm identifier, but "write a name matcher" is not the missing
piece — the data is.

## Rejected: NHTSA

`api.nhtsa.gov` answers 200 and is a genuinely good API, but **it has no
chronological recall endpoint.** `recalls/campaignNumber` requires the
campaign number you are looking for, and `products/vehicle/makes` returns a
list of makes. Both are lookup shapes: they answer "tell me about this
recall", never "what was recalled today".

A wire needs the second question. The bulk alternative is a zipped flat file
(`static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL.zip`), which is not something to
unzip on a Worker hot path. **Not dead — wrong shape.** Worth revisiting only
with a courier step, like the press-PDF lane.

## Rejected on fetch

| Endpoint | Result |
|---|---|
| `usitc.gov/rss/news_releases.xml` | **403** Access Denied |
| `cpsc.gov/Newsroom/CPSC-RSS-Feed/Recalls` | **404**, serves HTML |

USITC stays parked rather than worked around: doctrine #4, the client declares
itself and a host that refuses a declared UA has answered.

## The pattern across tonight's three batches

Four distinct rejection classes have now shown up, and they get harder to see
in order:

1. **Transport** — 404, 403, 503. A status check finds these.
2. **Shape** — 200 with items that parse to zero. Only running our own parser
   finds these.
3. **Editorially empty** — parses perfectly, carries no market intelligence
   (CBO, DOL). Only reading real titles finds these.
4. **Field-empty** — parses perfectly, the records look rich, and the one
   field you need is missing or unusable (CPSC). Only *counting across a real
   window* finds these, because a single sample record looks fine.

CPSC is the case for class 4. Its first record has a `Manufacturers` entry, so
inspecting one record would have said yes. It took 55 records to see that 33
of them do not.

---

## PRODUCT_RECALL has a length WINDOW, not a cap (2026-08-01, after review)

The p4 session's review of this chunk found that 24 of 38 live Class I device
events fail `renderPost` with `over_budget`, and `enqueueForApproval` turns
each into `status='logged'` — which the drain (`status='new'`) never sees
again, and the dedup key stops re-ingest. **Dropped permanently and silently.**

Reproduced on the shipped 10-row fixture through the real render path:

```
drug     6/6 rendered   {}
device   4/6 rendered   {"over_budget": 2}
```

Direction confirmed. Device `reason_for_recall` is simply longer: median 187
against drug's 124 here, 268 against 76 over the reviewer's live window.

### The obvious fix is wrong, and measuring it is what showed that

`draftRecall` caps `product` at 90 characters and leaves `reason` unbounded,
so completing that pattern looks like the fix. It is not: capping the reason
at 160, 130 and 110 moved device from 4/6 to 4/6 to 5/6.

Making the composer budget-aware brought every fact line from up to 448
weighted characters down to ~301 — and **two events still failed at 301 while
others rendered at 301 and 302.** Same length, opposite outcomes, because the
seed picks different skeletons and they are not the same size.

Sweeping the budget against the real render path:

| fact-line budget | drug | device |
|---|---|---|
| 300 | 6/6 | 4/6 |
| **260** | 6/6 | **6/6** |
| 220 | 6/6 | 5/6 |
| 200 | 6/6 | 4/6 |
| 180 | 6/6 | 4/6 |
| 160 | 6/6 | 4/6 |

**Non-monotonic.** Shorter is worse below 260, so there is a FLOOR as well as
a ceiling: a fact line has to land inside a window the archetype never states.
A composer that targets a cap can push a line under the floor and make things
worse, which the 200 and 180 rows show happening.

### So nothing shipped

260 renders all six here. Tuning a constant to a six-event fixture when the
reviewer measured thirty-eight is fitting noise, and the budget-aware composer
was reverted with it — a change that trims toward an unknown floor is not
obviously safe for drug and food either, and those lanes work today.

**The real finding is the window, and it belongs to PRODUCT_RECALL rather than
to an ingester.** An archetype that refuses a fact line for being too long AND
for being too short, without stating either bound, cannot be targeted by the
code that builds the line. That contract needs writing down before the device
lane can queue honestly.

Until then this chunk registers the source and lakes the events. **It should
not be treated as a working posting lane**, and the 33% figure here is the
fixture's, not production's.
