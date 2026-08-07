# Payload packs: the four provisional archetypes (B-08.4)

Sent in parallel with the provisional exemplars, per B-08.4. **Do not wait on
these** — the provisionals are installed and generating now. When owner or
advisor text arrives it replaces a provisional **one for one**, matched by
archetype and register.

Every field below is real, read out of production D1 for the card named. The
provisional exemplars in `src/rag/stylepack.ts` were written against exactly
these payloads and are validated against them by
`test/provisionalExemplars.test.ts` (full `FLOOR_GATES`, register guard, the
272 margin, and the structural law).

## What a replacement has to clear

- every number traceable to a field below, no exceptions
- attribution on the head fact line, one beat last, never blended
- at or under **272 weighted** (the margin rule; 280 is the hard cap)
- no em-dash, no hashtag, no advice verbs, no BREAKING
- the beat must **cash out**: a definitional line needs a payload field or a
  registry entry behind it, or the aphorism scorer refuses it

Three of my own drafts died on that last rule while writing these, which is
the rule working.

## INSIDER_NOTICE — card #1231 / #1232

A Form 144 is a NOTICE of a proposed sale. It reports an intention, not a completed trade, and it is the only insider form that points at the future. `pctOfOutstanding` is 0 here because 10,000 against 941,357,065 rounds to zero, which is itself the story on a mega-cap.

```json
{
 "phase": "detail",
 "accession": "0001949846-26-000477",
 "issuerCik": "0000059478",
 "issuerName": "ELI LILLY & Co",
 "sellerName": "Hakim Anat",
 "relationships": [
  "Officer"
 ],
 "relationshipLabel": "Officer",
 "securitiesClass": "COMMON",
 "broker": "THE CHARLES SCHWAB CORPORATION",
 "unitsSold": 10000,
 "aggregateMarketValue": 11900000,
 "unitsOutstanding": 941357065,
 "approxSaleDate": "08/07/2026",
 "approxSaleIso": "2026-08-07",
 "exchange": "NYSE",
 "pctOfOutstanding": 0,
 "isGift": false,
 "acquisitionNature": "RSU/A Award",
 "acquisitionIsExercise": false,
 "factLine": "Hakim Anat (Officer) filed notice of a proposed sale of 10,000 shares, $11.9M of ELI LILLY & Co on or after 08/07/2026"
}
```

## DELISTING — card #947

This is a NOTE reaching its stated 2026 maturity, not a company falling off the board, and Form 25 does not distinguish the two. `exchangeInitiated` is the field that separates a routine maturity from a company being removed.

```json
{
 "phase": "detail",
 "exchange": "NEW YORK STOCK EXCHANGE LLC",
 "issuerName": "PROCTER & GAMBLE Co",
 "issuerCik": "0000080424",
 "securityClass": "3.250% Notes due 2026",
 "ruleProvision": "17 CFR 240.12d2-2(a)(2)",
 "signatureDate": "2026-08-03",
 "exchangeInitiated": true,
 "factLine": "NEW YORK STOCK EXCHANGE LLC filed to remove PROCTER & GAMBLE Co (3.250% Notes due 2026) from listing, filed 2026-08-03"
}
```

## OWNERSHIP_STAKE — card #321 (open five weeks)

13D is the ACTIVIST form; 13G is the passive one. Filing 13D at 67.5% is control plus declared intent. `isSchedule13D` is the field that carries that distinction, and `topPercent` is the one number that matters.

```json
{
 "phase": "detail",
 "formType": "SCHEDULE 13D",
 "isAmendment": false,
 "isSchedule13D": true,
 "issuerCik": "0002018462",
 "issuerName": "PicoCELA Inc.",
 "cusip": "71989C208",
 "securitiesClass": "American depositary shares, each representing one common share",
 "dateOfEvent": "07/16/2026",
 "dateOfEventIso": "2026-07-16",
 "previouslyFiled": false,
 "persons": [
  {
   "name": "About Investment Pte. Ltd.",
   "cik": "0002134225",
   "type": "CO",
   "aggregateAmountOwned": 20000000,
   "percentOfClass": 67.5,
   "soleVotingPower": 0,
   "sharedVotingPower": 20000000
  },
  {
   "name": "Jiaming Li",
   "cik": null,
   "type": "IN",
   "aggregateAmountOwned": 20000000,
   "percentOfClass": 67.5,
   "soleVotingPower": 0,
   "sharedVotingPower": 20000000
  }
 ],
 "topPercent": 67.5,
 "topPersonName": "About Investment Pte. Ltd.",
 "factLine": "Schedule 13D: About Investment Pte. Ltd. reports 20,000,000 shares, 67.5% of PicoCELA Inc., event dated 07/16/2026"
}
```

## PRODUCT_RECALL — card #1076

`disclosureLagDays` (16) is the editorial fact: the gap between the firm deciding and the public being told. `voluntaryIsFirmInitiated` is what makes 'voluntary' mean 'they found it', not 'they found it early'.

```json
{
 "eventId": "99399",
 "firm": "Major Pharmaceuticals",
 "classification": "Class II",
 "status": "Ongoing",
 "reason": "Subpotent Drug",
 "product": "Levothyroxine Sodium Tablets, USP, 75 mcg (0.075 mg), 10 Tablets (10 x 1) unit dose blisters per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA. Distributed by Cardinal Health, Dublin, OH 43017. NDC Bag: 55154-3560-0; NDC Blister: 0904-6951-61",
 "quantity": "N/A",
 "distribution": "Nationwide in the USA.",
 "voluntary": "Voluntary: Firm initiated",
 "initiatedIso": "2026-07-13",
 "reportedIso": "2026-07-29",
 "disclosureLagDays": 16,
 "productCount": 12,
 "products": [
  "Levothyroxine Sodium Tablets, USP, 75 mcg (0.075 mg), 10 Tablets (10 x 1) unit dose blisters per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA. Distributed by Cardinal Health, Dublin, OH 43017. NDC Bag: 55154-3560-0; NDC Blister: 0904-6951-61",
  "Levothyroxine Sodium Tablets, USP, 150 mcg (0.0150 mg), 10 Tablets (10 x 1) unit dose blisters per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA. Distributed by Cardinal Health, Dublin, OH 43017. NDC Bag: 55154-3563-0; NDC Blister: 0904-6956-61",
  "Levothyroxine Sodium Tablets, USP, 88 mcg (0.088 mg), 100 Tablets (10 x 10 unit dose blisters) per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA.  NDC: 0904-6952-61",
  "Levothyroxine Sodium Tablets, USP, 75 mcg (0.075 mg), 100 Tablets (10 x 10 unit dose blisters) per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA.  NDC: 0904-6951-61",
  "Levothyroxine Sodium Tablets, USP, 125 mcg (0.0125 mg), 10 Tablets (10 x 1) unit dose blisters per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA. Distributed by Cardinal Health, Dublin, OH 43017. NDC Bag: 55154-3562-0; NDC Blister: 0904-6951-61",
  "Levothyroxine Sodium Tablets, USP, 25 mcg (0.025 mg), 100 Tablets (10 x 10 unit dose blisters) per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA.  NDC: 0904-6949-61",
  "Levothyroxine Sodium Tablets, USP, 50 mcg (0.050 mg), 100 Tablets (10 x 10 unit dose blisters) per carton, Rx only, Packaged and Distributed by: MAJOR PHARMACEUTICALS, Indianapolis, IN 46268 USA.  NDC: 0904-6950-61",
  "Levothyroxine Sodium Tablets, USP, 25 mcg (0.025 mg), 10 Tablets (10 x 1) unit dose blisters per carton, Rx only, Packaged and Distributed by: 
```
