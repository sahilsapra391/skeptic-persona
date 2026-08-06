import { fmtNum, fmtUsd } from "../ingesters/shared";
import { POST_TEXT_LIMIT, weightedLength } from "./length";
import { humanDate } from "./render";
import { RATE_ATTRIBUTION } from "../ingesters/rateAttribution";
import { PRESS_ATTRIBUTION } from "../ingesters/pressAttribution";
import type { Archetype, ArchetypeId, Payload, PendingBeat } from "./types";

// Beat libraries transcribed from docs/persona.md §8 (owner-signed).
// test/templates.test.ts parses that doc and fails when this drifts from it.
// Gates are declarative data; where the doc shows a bracketed condition the
// gate encodes it, and where it doesn't the beat still gets the gate its
// claim implies (e.g. "The lag is the product." requires a parsed lag).
//
// RETIRED 2026-08-06 (owner ruling on D-31): the metaphor-group beats
// `form4.decision`, `n144.noticeNotTrade` and `cluster.reason` are gone from
// both this file and persona.md. They were definitional lines that cashed out
// to a figure of speech rather than to a parsed field, and the owner's
// plain-voice directive now applies to pre-directive text. The provenance
// group STAYS, bound by the `source-owned-figure` registry entry.

const str = (p: Payload, k: string): string | null => {
  const v = p[k];
  return typeof v === "string" && v !== "" ? v : null;
};
const num = (p: Payload, k: string): number | null => {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/**
 * The SEC's compound item titles run long — Item 5.02 is "Departure of
 * Directors or Certain Officers; Election of Directors; Appointment of
 * Certain Officers; Compensatory Arrangements of Certain Officers" at 145
 * characters. Cut at the first semicolon, a clause boundary in the SEC's OWN
 * phrasing rather than an arbitrary character count, and mark the cut so a
 * reader knows the title continues.
 */
export function firstClause(title: string, max = 80): string {
  const semi = title.indexOf(";");
  const head = semi > 0 ? title.slice(0, semi) : title;
  if (head.length <= max) return semi > 0 ? `${head}\u2026` : head;
  const cut = head.lastIndexOf(" ", max);
  return `${head.slice(0, cut > 40 ? cut : max).trimEnd()}\u2026`;
}

/** Item codes we translate; the SEC's own titles always come from the feed. */
const itemsOf = (p: Payload): Array<{ code: string; title: string }> =>
  Array.isArray(p.items) ? (p.items as Array<{ code: string; title: string }>) : [];

// ---------------------------------------------------------------------------
// FILING_8K

const filing8k: Archetype = {
  id: "FILING_8K",
  attribution: "per SEC",
  skeletons: [
    {
      id: "8k.items",
      build: (p) => {
        const company = str(p, "company");
        const substantive = itemsOf(p).filter((i) => i.code !== "9.01");
        const shown = substantive.length > 0 ? substantive : itemsOf(p);
        if (!company || shown.length === 0) return null;
        return {
          lines: [`${str(p, "formType") ?? "8-K"}: ${company}`, ...shown.map((i) => `Item ${i.code}: ${i.title}`)],
        };
      },
    },
    {
      // GUARANTEED-SHORT variant. Both fuller skeletons can exceed the post
      // budget on a long compound title, and if EVERY skeleton overflows the
      // render fails and the filing silently never reaches the queue. Real
      // production drafts reached 471 characters.
      id: "8k.compact",
      build: (p) => {
        const company = str(p, "company");
        const first = itemsOf(p).filter((i) => i.code !== "9.01")[0] ?? itemsOf(p)[0];
        if (!company || !first) return null;
        const name = company.length > 55 ? `${company.slice(0, 52).trimEnd()}\u2026` : company;
        return { lines: [`${name}: Item ${first.code}, ${firstClause(first.title)}`] };
      },
    },
    {
      id: "8k.lead",
      build: (p) => {
        const company = str(p, "company");
        const first = itemsOf(p).filter((i) => i.code !== "9.01")[0] ?? itemsOf(p)[0];
        if (!company || !first) return null;
        const extra = itemsOf(p).filter((i) => i.code !== "9.01").length - 1;
        const tail = extra > 0 ? ` (+${extra} more item${extra > 1 ? "s" : ""})` : "";
        return { lines: [`${company} filed Item ${first.code}: ${first.title}${tail}`] };
      },
    },
  ],
  beats: [
    {
      id: "8k.retraction",
      text: "Non-reliance is the accounting version of a retraction.",
      tier: "base",
      when: { op: "includes", field: "itemCodes", value: "4.02" },
    },
    {
      id: "8k.ownclaim",
      text: "Prior financials can't be relied on. That's the filing's own claim.",
      tier: "base",
      when: { op: "includes", field: "itemCodes", value: "4.02" },
    },
    {
      id: "8k.notice",
      text: "Delisting notice, not a delisting.",
      tier: "base",
      when: { op: "includes", field: "itemCodes", value: "3.01" },
    },
    {
      id: "8k.materiality",
      text: "Choosing 1.05 is itself the materiality call.",
      tier: "base",
      when: { op: "includes", field: "itemCodes", value: "1.05" },
      literals: ["1.05"],
    },
    {
      id: "8k.502scope",
      text: "Item 5.02 covers exits and arrivals. The title is doing a lot of work.",
      tier: "base",
      when: { op: "includes", field: "itemCodes", value: "5.02" },
      literals: ["5.02"],
    },
    {
      id: "8k.bankruptcy",
      text: "Bankruptcy is the one item that never needs translating.",
      tier: "base",
      when: { op: "includes", field: "itemCodes", value: "1.03" },
    },
    {
      id: "8k.secondNonReliance",
      text: "Second non-reliance filing from this issuer this year.",
      tier: "escalation",
      // Requires a REAL prior in our lake, not an assumption.
      when: {
        op: "all",
        of: [
          { op: "includes", field: "itemCodes", value: "4.02" },
          { op: "eq", field: "sameItemOccurrence", value: 2 },
        ],
      },
    },
    {
      id: "8k.sameItemAgain",
      text: "Filing number {sameItemOccurrence} of this item from this issuer this year.",
      tier: "escalation",
      when: { op: "gte", field: "sameItemOccurrence", value: 3 },
    },
  ],
  // Escalation: the pattern across filings, now that the lookback can prove
  // it. These were PENDING until this query layer existed.
  guards: [
    // persona §11: never a beat on an amendment.
    { id: "8k.notAmendment", ok: (p) => !(str(p, "formType") ?? "").endsWith("/A") },
  ],
  pending: [] as readonly PendingBeat[],
};

// ---------------------------------------------------------------------------
// FILING_FORM4

const form4: Archetype = {
  id: "FILING_FORM4",
  attribution: "per SEC Form 4",
  skeletons: [
    {
      id: "form4.action",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "form4.whoWhat",
      build: (p) => {
        const who = str(p, "who");
        const action = str(p, "actionLine");
        return who && action ? { lines: [`${who}: ${action}`] } : null;
      },
    },
  ],
  beats: [
    {
      id: "form4.codeP",
      text: "Code P. Bought, not granted.",
      tier: "base",
      when: { op: "eq", field: "primaryCode", value: "P" },
    },
    {
      id: "form4.lag",
      text: "{lagDays} days from trade to filing.",
      tier: "base",
      when: { op: "gte", field: "lagDays", value: 2 },
    },
    {
      id: "form4.ownNumber",
      text: "The stake number is the filer's own.",
      tier: "base",
      // Only when the fact line actually prints a stake.
      when: { op: "eq", field: "stakePrinted", value: true },
    },
  ],
  guards: [{ id: "form4.notAmendment", ok: (p) => p.isAmendment !== true }],
};

// ---------------------------------------------------------------------------
// INSIDER_NOTICE (Form 144 — proposed sale, filed BEFORE it happens)

const insiderNotice: Archetype = {
  id: "INSIDER_NOTICE",
  attribution: "per SEC Form 144",
  skeletons: [
    {
      id: "n144.notice",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "n144.whoWhat",
      build: (p) => {
        const who = str(p, "sellerName");
        const issuer = str(p, "issuerName");
        const value = num(p, "aggregateMarketValue");
        if (!who || !issuer || value === null) return null;
        const rel = str(p, "relationshipLabel");
        const shares = num(p, "unitsSold");
        const size = shares === null ? fmtUsd(value) : `${fmtNum(shares)} shares (${fmtUsd(value)})`;
        // "proposed sale", never "to sell" — see draftForm144.
        return { lines: [`${who}${rel ? ` (${rel})` : ""} filed notice of a proposed sale: ${size} of ${issuer}`] };
      },
    },
  ],
  beats: [
    {
      id: "n144.beforeNotAfter",
      text: "This one is filed before the sale, not after.",
      tier: "base",
      when: { op: "has", field: "aggregateMarketValue" },
    },
    {
      id: "n144.brokerNamed",
      text: "The broker is named in the filing.",
      tier: "base",
      when: { op: "has", field: "broker" },
    },
    {
      id: "n144.optionSale",
      text: "Acquired by option exercise, sold the same notice.",
      tier: "base",
      // Only when the filing's OWN nature-of-acquisition text says so.
      when: { op: "eq", field: "acquisitionIsExercise", value: true },
    },
    // Escalation: size relative to the float, computed from two parsed fields.
    {
      id: "n144.pctFloat",
      // noOfUnitsOutstanding counts the CLASS named in the filing, not the
      // issuer's total. Naming the class keeps the claim true for dual-class
      // issuers; fillSlots fails closed if the class did not parse.
      text: "That is {pctOfOutstanding}% of {securitiesClass} outstanding.",
      tier: "escalation",
      when: {
        op: "all",
        of: [
          { op: "gte", field: "pctOfOutstanding", value: 1 },
          { op: "lte", field: "pctOfOutstanding", value: 100 },
          { op: "has", field: "securitiesClass" },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// INSIDER_CLUSTER

const insiderCluster: Archetype = {
  id: "INSIDER_CLUSTER",
  attribution: "per SEC Form 4 filings",
  skeletons: [
    {
      id: "cluster.roster",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "cluster.count",
      build: (p) => {
        const n = num(p, "memberCount");
        const sym = str(p, "symbol");
        const roster = str(p, "roster");
        if (n === null || !sym || !roster) return null;
        return { lines: [`${n} insiders bought ${sym} in the past week.`, roster] };
      },
    },
  ],
  beats: [
    {
      id: "cluster.filings",
      text: "{memberCount} separate filings, same issuer, same week.",
      tier: "base",
      when: { op: "gte", field: "memberCount", value: 3 },
    },
    {
      id: "cluster.buysOnly",
      text: "Buys only. Code P across every filer.",
      tier: "base",
      when: { op: "eq", field: "allCodeP", value: true },
    },
    {
      id: "cluster.calendar",
      text: "Seven calendar days, not seven sessions.",
      tier: "base",
      when: { op: "gte", field: "memberCount", value: 3 },
    },
    {
      id: "cluster.signatures",
      text: "{memberCount} signatures, not one.",
      tier: "base",
      when: { op: "gte", field: "memberCount", value: 3 },
    },
  ],
};

// ---------------------------------------------------------------------------
// CONGRESS_PTR (the signature archetype)

const congressPtr: Archetype = {
  id: "CONGRESS_PTR",
  // Both chambers share this archetype (same disclosure regime, same beats),
  // but NOT the same source. Hardcoding Senate here would have stamped every
  // House filing with a citation to a system it never touched.
  // PINNED PLAIN-ENGLISH FORMS (owner ruling 2026-08-06). "eFD" is the
  // Senate's internal system name and means nothing to a reader; the House
  // form keeps its article. Both old strings survive as aliases in
  // templates/attribution.ts, so legacy drafts still validate — but nothing
  // renders them again.
  attribution: {
    field: "chamber",
    map: { senate: "per Senate financial disclosures", house: "per the House Clerk" },
  },
  skeletons: [
    {
      id: "ptr.trades",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "ptr.whoWhen",
      build: (p) => {
        const who = str(p, "who");
        const trades = str(p, "tradeLine");
        const filed = str(p, "filedDate");
        if (!who || !trades || !filed) return null;
        return { lines: [`${who}: ${trades}`, `Filed ${filed}`] };
      },
    },
  ],
  beats: [
    { id: "ptr.disclosedLater", text: "Disclosed {lagDays} days later.", tier: "base", when: { op: "gte", field: "lagDays", value: 1 } },
    // THE WORKED EXAMPLE OF A BOUND DEFINITIONAL BEAT (owner ruling
    // 2026-08-06, closing D-31). It is a metaphor by form, and under the
    // aphorism rule that is not what decides it — CASH-OUT is. It cashes out
    // twice: to this item's own parsed lag, and to the definitions registry's
    // 45-day/$200 PTR entry (5 U.S.C. 13106).
    //
    // So it is GATED on the claim it actually makes. A filing disclosed
    // inside the statutory deadline has no lag worth calling a product, and
    // a day-3 disclosure must never carry this line. Fires only past 45.
    //
    // Widen to top-quartile lag once the pattern fields exist; until then the
    // deadline is the only threshold the record can license.
    { id: "ptr.lagProduct", text: "The lag is the product.", tier: "base", when: { op: "gt", field: "lagDays", value: 45 } },
    {
      id: "ptr.range",
      text: "Reported as a range. That's all the record shows.",
      tier: "base",
      when: { op: "has", field: "amountBand" },
    },
    {
      id: "ptr.dates",
      text: "Trade date {tradeDate}. Public {filedDate}.",
      tier: "base",
      // Single-transaction filings only: on a multi-trade PTR these two dates
      // would imply a lag that isn't true of the other trades.
      when: {
        op: "all",
        of: [
          { op: "has", field: "tradeDate" },
          { op: "has", field: "filedDate" },
          { op: "eq", field: "singleTxn", value: true },
        ],
      },
    },
    // Escalation tier: absurd cases only.
    { id: "ptr.readAgain", text: "Read that lag again.", tier: "escalation", when: { op: "gte", field: "lagDays", value: 30 } },
    { id: "ptr.eventually", text: "Filed eventually.", tier: "escalation", when: { op: "gte", field: "lagDays", value: 40 } },
    {
      id: "ptr.bandWork",
      text: "The range is doing a lot of work.",
      tier: "escalation",
      when: { op: "gte", field: "bandWidthUsd", value: 1_000_000 },
    },
  ],
};

// ---------------------------------------------------------------------------
// MACRO_PRINT (BLS)

const macroPrint: Archetype = {
  id: "MACRO_PRINT",
  attribution: "per BLS",
  skeletons: [
    {
      id: "macro.full",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "macro.headline",
      build: (p) => {
        const name = str(p, "releaseName");
        const mom = str(p, "momText");
        const month = str(p, "refMonth");
        if (!name || !mom || !month) return null;
        return { lines: [`${name}, ${month}: ${mom}`] };
      },
    },
  ],
  beats: [
    {
      id: "macro.coreAbove",
      text: "Core above headline this month.",
      tier: "base",
      when: { op: "gtField", field: "coreSigned", other: "momSigned" },
    },
    {
      id: "macro.twelve",
      text: "One month of data. The y/y line covers twelve.",
      tier: "base",
      when: { op: "has", field: "yoyPct" },
    },
    {
      id: "macro.headlineOnly",
      text: "Headline only. The rest is in the release.",
      tier: "base",
      when: { op: "eq", field: "partialParse", value: true },
    },
    // Escalation: the release's OWN superlative, quoted verbatim.
    {
      id: "macro.ownSuperlative",
      text: "The release's words: {superlative}",
      tier: "escalation",
      when: { op: "has", field: "superlative" },
    },
  ],
};

// ---------------------------------------------------------------------------
// FED_PRESS

const fedPress: Archetype = {
  id: "FED_PRESS",
  attribution: "per the Federal Reserve", // D-33: one pin per source; the bare form is an alias
  skeletons: [
    {
      id: "fed.categoryLead",
      build: (p) => {
        const title = str(p, "title");
        const category = str(p, "category");
        return title && category ? { lines: [`Fed, ${category}: ${title}`] } : null;
      },
    },
    {
      id: "fed.plain",
      build: (p) => {
        const title = str(p, "title");
        return title ? { lines: [`Fed: ${title}`] } : null;
      },
    },
  ],
  // The statement-diff beats live in PENDING_BEATS: they describe a diff
  // between consecutive FOMC statements, and the diff engine is P3. A beat
  // that can never fire is a lie in the library, so they are unreachable by
  // type until the engine exists.
  beats: [],
};

// ---------------------------------------------------------------------------
// RATE_DECISION (central bank policy rate moved)

const rateDecision: Archetype = {
  id: "RATE_DECISION",
  // Each bank cited by name, selected from a CLOSED map on payload.country.
  // This used to be the generic "per the central bank" because the renderer
  // took one string; the map form added for CONGRESS_PTR removed that limit.
  // The map is imported, never restated: one authored copy shared with
  // RATE_SOURCES, so a bank cannot be cited one way in the fact line and
  // another in the post.
  attribution: { field: "country", map: RATE_ATTRIBUTION },
  skeletons: [
    {
      id: "rate.change",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "rate.countryFirst",
      build: (p) => {
        const country = str(p, "country");
        const label = str(p, "label");
        const value = num(p, "value");
        const prior = num(p, "priorValue");
        const dir = str(p, "direction");
        if (!country || !label || value === null || prior === null || !dir) return null;
        return { lines: [`${country} ${dir} its ${label} to ${value}% from ${prior}%`] };
      },
    },
  ],
  beats: [
    {
      id: "rate.bps",
      text: "{changeBps} basis points.",
      tier: "base",
      when: { op: "gte", field: "changeBps", value: 1 },
    },
    {
      id: "rate.priorLevel",
      text: "The level had held at {priorValue}% since {priorDate}.",
      tier: "base",
      when: {
        op: "all",
        of: [
          { op: "has", field: "priorValue" },
          { op: "has", field: "priorDate" },
        ],
      },
    },
    {
      id: "rate.effective",
      text: "Effective {observedDate}, in the bank's own series.",
      tier: "base",
      when: { op: "has", field: "observedDate" },
    },
    // Escalation: a large move, measured from two parsed values.
    {
      id: "rate.jumbo",
      text: "{changeBps} basis points in one step.",
      tier: "escalation",
      when: { op: "gte", field: "changeBps", value: 50 },
    },
  ],
};

// ---------------------------------------------------------------------------
// TREASURY_AUCTION

const treasuryAuction: Archetype = {
  id: "TREASURY_AUCTION",
  attribution: "per US Treasury",
  skeletons: [
    {
      id: "auction.result",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "auction.termFirst",
      build: (p) => {
        const term = str(p, "securityTerm");
        const type = str(p, "securityType");
        const cover = num(p, "bidToCoverRatio");
        const yld = num(p, "highYield");
        if (!term || !type || cover === null || yld === null) return null;
        return { lines: [`${term} ${type}: ${yld}% high yield, ${cover} bid-to-cover`] };
      },
    },
  ],
  beats: [
    {
      id: "auction.indirect",
      text: "Indirect bidders took {indirectPct}% of the competitive award.",
      tier: "base",
      when: { op: "has", field: "indirectPct" },
    },
    {
      id: "auction.allocation",
      text: "{allocationPercentage}% allotted at the high.",
      tier: "base",
      when: { op: "has", field: "allocationPercentage" },
    },
    {
      id: "auction.coverIsDemand",
      text: "Bid-to-cover is the demand, not the price.",
      tier: "base",
      when: { op: "has", field: "bidToCoverRatio" },
    },
    // Escalation: a weak cover is the newsworthy auction.
    {
      id: "auction.weakCover",
      // NOT "coming up short": \bshort\b is a banned advice token and the
      // poster's register guard would block every weak-auction post.
      text: "Barely covered.",
      tier: "escalation",
      when: { op: "lte", field: "bidToCoverRatio", value: 2.1 },
    },
  ],
};

// ---------------------------------------------------------------------------
// PRODUCT_RECALL (FDA drug enforcement)

/** Declared once so recall.firmFirst can measure the FINISHED head line
 *  against the post budget instead of reserving a guessed allowance. */
const RECALL_ATTRIBUTION = "per FDA";

const productRecall: Archetype = {
  id: "PRODUCT_RECALL",
  attribution: RECALL_ATTRIBUTION,
  skeletons: [
    {
      id: "recall.full",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "recall.firmFirst",
      build: (p) => {
        const firm = str(p, "firm");
        const cls = str(p, "classification");
        const reason = str(p, "reason");
        if (!firm || !cls || !reason) return null;
        // THE LENGTH WINDOW (p5-04). Measured 2026-08-05 against production:
        // 100 recall items, FDA `reason` strings running 14 to 454 characters
        // and `factLine` to 623. Thirty-five of the 100 cannot render
        // recall.full at all, and the long-reason ones blew this skeleton too,
        // so the archetype could reach over_budget with no shape left.
        //
        // The reason is included only when the FINISHED line still fits, and
        // is OMITTED rather than truncated when it does not. A half-sentence
        // FDA reason ("...due to undeclared") reads as a different claim from
        // the one the agency made, which is the fabrication class this repo
        // closes twice over. Dropping it states less; truncating it states
        // something else.
        //
        // The budget is computed, not guessed: this archetype's own
        // attribution is a fixed string, so the exact finished head line can
        // be measured here rather than approximated with a reserve constant.
        const withReason = `${firm} is recalling product. ${cls}, reason: ${reason}`;
        const finished = `${withReason}, ${RECALL_ATTRIBUTION}`;
        if (weightedLength(finished) <= POST_TEXT_LIMIT) return { lines: [withReason] };
        return { lines: [`${firm} is recalling product. ${cls}`] };
      },
    },
  ],
  beats: [
    // The signature move: the gap between the firm acting and the public
    // finding out, both dates parsed from the record.
    {
      id: "recall.lag",
      // :date, not the raw ISO (p5-04). persona.md specifies this beat as
      // "Initiated {d1}. Published {d2}." — a human date was always the ask.
      text: "Initiated {initiatedIso:date}. Published {reportedIso:date}.",
      tier: "base",
      when: {
        op: "all",
        of: [
          { op: "has", field: "initiatedIso" },
          { op: "has", field: "reportedIso" },
        ],
      },
    },
    {
      id: "recall.classIsFdas",
      text: "The class is the FDA's grading, not ours.",
      tier: "base",
      when: { op: "has", field: "classification" },
    },
    {
      id: "recall.voluntary",
      text: "Firm-initiated, in the agency's own words.",
      tier: "base",
      // Only when FDA's field says so.
      when: { op: "eq", field: "voluntaryIsFirmInitiated", value: true },
    },
    {
      id: "recall.stillOngoing",
      text: "Status: ongoing.",
      tier: "base",
      when: { op: "eq", field: "status", value: "Ongoing" },
    },
    // Escalation: a long gap between action and disclosure.
    {
      id: "recall.slowDisclosure",
      text: "{disclosureLagDays} days from the firm acting to the public knowing.",
      tier: "escalation",
      when: { op: "gte", field: "disclosureLagDays", value: 30 },
    },
  ],
};

// ---------------------------------------------------------------------------
// POLICY_ACTION (executive orders, proclamations, determinations)

const policyAction: Archetype = {
  id: "POLICY_ACTION",
  attribution: "per Federal Register",
  skeletons: [
    {
      id: "policy.numbered",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "policy.titleFirst",
      build: (p) => {
        const title = str(p, "title");
        const kind = str(p, "kind");
        const pub = str(p, "publicationDate");
        if (!title || !kind || !pub) return null;
        return { lines: [`${title}. ${kind}, published ${pub}`] };
      },
    },
  ],
  beats: [
    {
      id: "policy.signedVsPublished",
      text: "Signed {signingDate}. Published {publicationDate}.",
      tier: "base",
      when: {
        op: "all",
        of: [
          { op: "has", field: "signingDate" },
          { op: "has", field: "publicationDate" },
        ],
      },
    },
    {
      id: "policy.numbered",
      text: "Numbered in the series, so it is countable.",
      tier: "base",
      when: { op: "has", field: "number" },
    },
    {
      id: "policy.textIsTheDocument",
      text: "The document is the source. No summary in between.",
      tier: "base",
      when: { op: "has", field: "documentNumber" },
    },
    // Escalation: a long gap between signing and publication.
    {
      id: "policy.publicationLag",
      text: "{signingLagDays} days from signature to publication.",
      tier: "escalation",
      when: { op: "gte", field: "signingLagDays", value: 7 },
    },
  ],
};

// ---------------------------------------------------------------------------
// POSITIONING (CFTC Commitments of Traders)

const positioning: Archetype = {
  id: "POSITIONING",
  attribution: "per CFTC",
  skeletons: [
    {
      id: "cot.net",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "cot.contractFirst",
      build: (p) => {
        const contract = str(p, "contract");
        const net = num(p, "levNet");
        const week = str(p, "reportDate");
        if (!contract || net === null || !week) return null;
        const side = net >= 0 ? "net long" : "net short";
        return { lines: [`${contract}: leveraged funds ${side} ${Math.abs(net).toLocaleString("en-US")} contracts, week ending ${week}`] };
      },
    },
  ],
  beats: [
    {
      id: "cot.weekly",
      text: "Positioning as of the Tuesday close, published Friday.",
      tier: "base",
      when: { op: "has", field: "reportDate" },
    },
    {
      id: "cot.cftcMath",
      text: "The weekly change is the CFTC's own figure.",
      tier: "base",
      when: { op: "has", field: "changeLevNet" },
    },
    {
      id: "cot.openInterest",
      text: "Against {openInterest} contracts of open interest.",
      tier: "base",
      when: { op: "has", field: "openInterest" },
    },
  ],
};

// ---------------------------------------------------------------------------
// OWNERSHIP_STAKE (Schedule 13D / 13G)

const ownershipStake: Archetype = {
  id: "OWNERSHIP_STAKE",
  attribution: "per SEC",
  skeletons: [
    {
      id: "stake.report",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "stake.holderFirst",
      build: (p) => {
        const who = str(p, "topPersonName");
        const issuer = str(p, "issuerName");
        const pct = num(p, "topPercent");
        if (!who || !issuer || pct === null) return null;
        return { lines: [`${who} reports ${pct}% of ${issuer}`] };
      },
    },
  ],
  beats: [
    {
      id: "stake.13dIsIntent",
      text: "A 13D is the activist form. A 13G is the passive one.",
      tier: "base",
      literals: ["13", "13"],
      when: { op: "eq", field: "isSchedule13D", value: true },
    },
    {
      id: "stake.eventDate",
      text: "Triggering event dated {dateOfEvent}.",
      tier: "base",
      when: { op: "has", field: "dateOfEvent" },
    },
    {
      id: "stake.coverPage",
      text: "Cover-page numbers, not the narrative items.",
      tier: "base",
      when: { op: "has", field: "topPercent" },
    },
    // Escalation: a controlling-size position.
    {
      id: "stake.large",
      text: "{topPercent}% of the class, in one filer's hands.",
      tier: "escalation",
      when: { op: "gte", field: "topPercent", value: 10 },
    },
  ],
  guards: [
    // An amendment restates a position we may already have posted.
    { id: "stake.notAmendment", ok: (p) => p.isAmendment !== true },
  ],
};

// ---------------------------------------------------------------------------
// REGULATORY_NEWS (regulator press releases — NUMBERLESS by construction)

const regulatoryNews: Archetype = {
  id: "REGULATORY_NEWS",
  // The named body, resolved from payload.authority through the one authored
  // map. The generic "per the issuing authority" contradicted the owner's
  // exemplars ("per SEC"/"per CFTC"/"per FTC") and made the validator reject
  // every generated variant on the first live run (queue #918, 2026-08-01).
  attribution: { field: "authority", map: PRESS_ATTRIBUTION },
  skeletons: [
    {
      id: "reg.headline",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "reg.authorityFirst",
      build: (p) => {
        const authority = str(p, "authority");
        const title = str(p, "title");
        if (!authority || !title) return null;
        // NO "Announced by {authority}" (p5-04). render.ts appends the
        // resolved attribution to this head line, so stating the authority
        // here produced it twice in live drafts:
        //   "... (Projections for Aug.). Announced by Bank of Japan, per the
        //    Bank of Japan"
        // The authority gate stays: this skeleton is only offered for items
        // that HAVE an attributable authority, which is what makes the
        // appended citation correct. It is the restatement that goes, not the
        // requirement.
        return { lines: [title] };
      },
    },
  ],
  // These sources carry no parsed numbers, so the beats carry none either.
  // A template that cannot interpolate a figure cannot invent one.
  beats: [
    {
      id: "reg.primary",
      text: "The announcement itself, not a report of it.",
      tier: "base",
      when: { op: "has", field: "authority" },
    },
    {
      id: "reg.dateStamped",
      // :date, not the raw ISO (p5-04). publishedIso is ALWAYS a full
      // timestamp (regulatoryPress.ts returns d.toISOString() on both paths),
      // so this beat printed "Published 2026-08-04T01:00:00.000Z." into
      // copy-ready drafts. persona.md specifies it as "Published {date}.".
      text: "Published {publishedIso:date}.",
      tier: "base",
      when: { op: "has", field: "publishedIso" },
    },
  ],
};

// ---------------------------------------------------------------------------
// INSTITUTIONAL_13F_BREAKDOWN
//
// The long-form filing post, made short. The owner ruled out X Premium, so
// the POST is a hook plus two or three headline facts plus both dates, and
// the FULL breakdown (top ten, new/add/trim/gone) rides on the rendered card.
//
// Both dates are non-negotiable and the skeletons enforce it by construction:
// a 13F is a snapshot of a quarter END filed up to six weeks later, and a
// post that states only one date invites a reader to treat stale positions as
// current. Every skeleton here requires asOfIso AND filedIso, so a payload
// missing either renders nothing rather than a half-dated claim.
//
// "Gone" is a section label, never a verb. A holding absent from a filing was
// not necessarily sold, and no beat or skeleton below says it was.

const institutional13fBreakdown: Archetype = {
  id: "INSTITUTIONAL_13F_BREAKDOWN",
  attribution: "per SEC",
  skeletons: [
    {
      id: "f13.quickVersion",
      build: (p) => {
        const manager = str(p, "manager");
        const aum = str(p, "aum_display");
        const count = str(p, "positionCount_display");
        const asOf = str(p, "asOfIso");
        const filed = str(p, "filedIso");
        if (!manager || !aum || !count || !asOf || !filed) return null;
        // Formatted HERE, not with slot syntax: skeleton lines are built in
        // code and never pass through fillSlots, so "{asOfIso:date}" would
        // reach copy verbatim. renderPost now refuses such a post outright.
        const a = humanDate(asOf);
        const f = humanDate(filed);
        if (!a || !f) return null;
        return { lines: [`${manager}: ${aum} across ${count} positions, as of ${a}, filed ${f}`] };
      },
    },
    {
      id: "f13.sectionCounts",
      build: (p) => {
        const manager = str(p, "manager");
        const nNew = str(p, "newCount_display");
        const nGone = str(p, "goneCount_display");
        const asOf = str(p, "asOfIso");
        const filed = str(p, "filedIso");
        if (!manager || !nNew || !nGone || !asOf || !filed) return null;
        const a = humanDate(asOf);
        const f = humanDate(filed);
        if (!a || !f) return null;
        const unchanged = str(p, "unchangedCount_display");
        const unchangedTotal = str(p, "unchangedTotal_display");
        const tail = unchanged && unchangedTotal ? `, ${unchanged} untouched worth ${unchangedTotal}` : "";
        return { lines: [`${manager}: ${nNew} new, ${nGone} gone${tail}, as of ${a}, filed ${f}`] };
      },
    },
  ],
  beats: [
    {
      id: "f13.cardCarriesIt",
      text: "Full top ten on the card.",
      tier: "base",
      when: { op: "has", field: "aum_display" },
    },
    {
      id: "f13.lag",
      // The signature fact of this archetype: what you are reading is old.
      text: "Positions as of {asOfIso:date}. You are reading it {filedIso:date}.",
      tier: "base",
      when: {
        op: "all",
        of: [
          { op: "has", field: "asOfIso" },
          { op: "has", field: "filedIso" },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// SETTLEMENT_FAILURE (Reg SHO threshold list entry)

const settlementFailure: Archetype = {
  id: "SETTLEMENT_FAILURE",
  attribution: "per Nasdaq",
  skeletons: [
    {
      id: "regsho.joined",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "regsho.symbolFirst",
      build: (p) => {
        const symbol = str(p, "symbol");
        const date = str(p, "listDate");
        if (!symbol || !date) return null;
        const name = str(p, "name");
        return { lines: [`${symbol}${name ? ` (${name})` : ""} is on the Reg SHO threshold list as of ${date}`] };
      },
    },
  ],
  beats: [
    {
      id: "regsho.fiveDays",
      text: "That takes five straight settlement days of failures to deliver.",
      tier: "base",
      when: { op: "has", field: "listDate" },
    },
    {
      id: "regsho.mechanical",
      text: "The list is mechanical. The reason is not published.",
      tier: "base",
      when: { op: "has", field: "symbol" },
    },
    {
      id: "regsho.listSize",
      text: "{listSize} securities on the list that day.",
      tier: "base",
      when: { op: "gte", field: "listSize", value: 1 },
    },
  ],
};

// ---------------------------------------------------------------------------
// DELISTING (Form 25 / 25-NSE)

const delisting: Archetype = {
  id: "DELISTING",
  attribution: "per SEC",
  skeletons: [
    {
      id: "delist.exchangeFirst",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "delist.issuerFirst",
      build: (p) => {
        const issuer = str(p, "issuerName");
        const exchange = str(p, "exchange");
        if (!issuer || !exchange) return null;
        const cls = str(p, "securityClass");
        return { lines: [`${issuer}${cls ? ` (${cls})` : ""} is being removed from listing by ${exchange}`] };
      },
    },
  ],
  beats: [
    {
      id: "delist.thisIsTheDelisting",
      text: "This is the delisting, not the notice.",
      tier: "base",
      when: { op: "eq", field: "exchangeInitiated", value: true },
    },
    {
      id: "delist.rule",
      text: "Filed under {ruleProvision}.",
      tier: "base",
      when: { op: "has", field: "ruleProvision" },
    },
    {
      id: "delist.exchangeActed",
      text: "The exchange filed it, not the company.",
      tier: "base",
      when: { op: "eq", field: "exchangeInitiated", value: true },
    },
  ],
};

// ---------------------------------------------------------------------------
// STORM (NHC active Atlantic hurricanes)

const storm: Archetype = {
  id: "STORM",
  attribution: "per the National Hurricane Center",
  skeletons: [
    {
      id: "storm.named",
      build: (p) => {
        const line = str(p, "factLine");
        return line ? { lines: [line] } : null;
      },
    },
    {
      id: "storm.intensityFirst",
      build: (p) => {
        const name = str(p, "name");
        const kt = num(p, "intensityKt");
        if (!name || kt === null) return null;
        const mb = num(p, "pressureMb");
        return { lines: [`${name}: ${kt} kt sustained${mb === null ? "" : `, ${mb} mb`}, Atlantic basin`] };
      },
    },
  ],
  beats: [
    {
      id: "storm.ownUnits",
      text: "Knots and millibars, in the center's own units.",
      tier: "base",
      when: { op: "has", field: "intensityKt" },
    },
    {
      id: "storm.noForecast",
      text: "That is the current advisory. The track is not ours to call.",
      tier: "base",
      when: { op: "has", field: "classification" },
    },
    {
      id: "storm.major",
      text: "{intensityKt} kt puts it in major-hurricane territory.",
      tier: "escalation",
      when: { op: "gte", field: "intensityKt", value: 96 },
    },
  ],
};

// ---------------------------------------------------------------------------
// HALT

const halt: Archetype = {
  id: "HALT",
  attribution: "per Nasdaq",
  skeletons: [
    {
      id: "halt.symbolReason",
      build: (p) => {
        const symbol = str(p, "symbol");
        const reason = str(p, "reasonText");
        const time = str(p, "haltTimeEtShort");
        if (!symbol || !reason || !time) return null;
        const name = str(p, "name");
        return { lines: [`HALT: ${symbol}${name ? ` (${name})` : ""}. ${reason}, ${time} ET`] };
      },
    },
    {
      id: "halt.terse",
      build: (p) => {
        const symbol = str(p, "symbol");
        const reason = str(p, "reasonText");
        if (!symbol || !reason) return null;
        return { lines: [`${symbol} halted. ${reason}`] };
      },
    },
  ],
  beats: [
    { id: "halt.pending", text: "Pending is the whole disclosure.", tier: "base", when: { op: "eq", field: "reasonCode", value: "T1" } },
    {
      id: "halt.band",
      text: "The band did what the band does.",
      tier: "base",
      when: { op: "any", of: [{ op: "eq", field: "reasonCode", value: "LUDP" }, { op: "eq", field: "reasonCode", value: "LUDS" }] },
    },
    { id: "halt.codeStory", text: "The code is the whole story so far.", tier: "base", when: { op: "has", field: "reasonCode" } },
    { id: "halt.guessing", text: "Past this line it would be guessing.", tier: "base", when: { op: "has", field: "reasonCode" } },
    // Escalation: a symbol tripping the band repeatedly is the story. The
    // count is a lookback over our own lake, not an inference.
    {
      id: "halt.nthToday",
      text: "Halt number {haltCountToday} for this symbol today.",
      tier: "escalation",
      when: { op: "gte", field: "haltCountToday", value: 3 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Beats the doc marks DISABLED-UNTIL-BUILT. Declared for documentation and
// the parity test; unreachable by type (no `when`, branded).

export const PENDING_BEATS: readonly PendingBeat[] = [
  { id: "tape.casino", text: "The casino is the market now.", requires: ["tape_join"] },
  // Statement-diff family: needs the P3 FOMC diff engine.
  { id: "fed.editIsNews", text: "The edit is the entire news.", requires: ["statement_diff"] },
  { id: "fed.verbatim", text: "Everything else is verbatim.", requires: ["statement_diff"] },
  { id: "fed.interpretations", text: "The diff will not change. The interpretations will.", requires: ["statement_diff"] },
  { id: "fed.punctuation", text: "Punctuation counts here too.", requires: ["statement_diff"] },
  { id: "fed.adjectives", text: "Adjectives are load bearing in this document.", requires: ["statement_diff"] },
  // Paper PTRs are scored log-only, so they never reach the queue. Promoting
  // them is an OWNER call, not a code decision.
  { id: "ptr.paper", text: "Paper filing. Scanned, technically public.", requires: ["paper_ptr_postable"] },
] as unknown as readonly PendingBeat[];

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  FILING_8K: filing8k,
  FILING_FORM4: form4,
  INSIDER_NOTICE: insiderNotice,
  INSIDER_CLUSTER: insiderCluster,
  CONGRESS_PTR: congressPtr,
  MACRO_PRINT: macroPrint,
  FED_PRESS: fedPress,
  RATE_DECISION: rateDecision,
  TREASURY_AUCTION: treasuryAuction,
  PRODUCT_RECALL: productRecall,
  POLICY_ACTION: policyAction,
  POSITIONING: positioning,
  OWNERSHIP_STAKE: ownershipStake,
  REGULATORY_NEWS: regulatoryNews,
  INSTITUTIONAL_13F_BREAKDOWN: institutional13fBreakdown,
  SETTLEMENT_FAILURE: settlementFailure,
  DELISTING: delisting,
  STORM: storm,
  HALT: halt,
};
