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
