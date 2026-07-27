import { fmtNum, fmtUsd } from "../ingesters/shared";
import type { Archetype, ArchetypeId, Payload, PendingBeat } from "./types";

// Beat libraries transcribed from docs/persona.md §8 (owner-signed).
// test/templates.test.ts parses that doc and fails when this drifts from it.
// Gates are declarative data; where the doc shows a bracketed condition the
// gate encodes it, and where it doesn't the beat still gets the gate its
// claim implies (e.g. "The lag is the product." requires a parsed lag).

const str = (p: Payload, k: string): string | null => {
  const v = p[k];
  return typeof v === "string" && v !== "" ? v : null;
};
const num = (p: Payload, k: string): number | null => {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

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
    {
      id: "form4.decision",
      text: "An award is compensation. A P is a decision.",
      tier: "base",
      when: { op: "eq", field: "primaryCode", value: "P" },
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
      id: "n144.noticeNotTrade",
      text: "A 144 is the intent. The Form 4 is the receipt.",
      tier: "base",
      // "144" and "4" are FORM NAMES, not claims about the filing's data.
      literals: ["144", "4"],
      when: { op: "has", field: "aggregateMarketValue" },
    },
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
    {
      id: "cluster.reason",
      text: "The cluster is the fact. The reason isn't filed.",
      tier: "base",
      when: { op: "gte", field: "memberCount", value: 3 },
    },
  ],
};

// ---------------------------------------------------------------------------
// CONGRESS_PTR (the signature archetype)

const congressPtr: Archetype = {
  id: "CONGRESS_PTR",
  attribution: "per Senate eFD",
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
    { id: "ptr.lagProduct", text: "The lag is the product.", tier: "base", when: { op: "gte", field: "lagDays", value: 1 } },
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
  attribution: "per Federal Reserve",
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
  HALT: halt,
};
