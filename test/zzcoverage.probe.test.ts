import { describe, it } from "vitest";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";
import { ARCHETYPES } from "../src/templates/archetypes";
import type { Payload } from "../src/templates/types";

// ---------------------------------------------------------------------------
// PROTOTYPE: coverageCheck
// ---------------------------------------------------------------------------

const SUFFIXES = [
  "ators", "atory", "ations", "atives", "ative", "ator", "ation",
  "ings", "ions", "ments", "ment", "ing", "ion", "ers", "ies", "ied",
  "er", "es", "ed", "ly", "s",
];

export function stem(raw: string): string {
  let w = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (w.length <= 3) return w;
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) {
      w = w.slice(0, w.length - suf.length);
      break;
    }
  }
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.split(/[^A-Za-z0-9$-]+/)) {
    if (t.length === 0) continue;
    out.add(stem(t));
    // hyphenated compounds license their parts
    if (t.includes("-")) for (const p of t.split("-")) if (p) out.add(stem(p));
  }
  return out;
}

/** Words that name the artifact we hold. Always free: a claim ABOUT the
 *  record is checkable against the record. */
const RECORD_DEIXIS = [
  "filing", "file", "filed", "document", "record", "order", "notice", "report",
  "statement", "disclosure", "disclose", "page", "line", "number", "figure",
  "date", "form", "item", "text", "paper", "pdf", "dataset", "lake", "feed",
  "release", "case", "matter", "wording", "language", "word", "sentence",
  "headline", "title", "print", "data", "entry", "row", "field", "column",
];

/** Domain vocabulary: finance, law, regulation, market structure. A term here
 *  enters a take ONLY if the licensed universe states it. */
const DOMAIN_WORDS = [
  // instruments & market structure
  "derivative", "security", "securities", "equity", "bond", "treasury",
  "future", "option", "swap", "commodity", "commodities", "warrant",
  "debenture", "note", "collateral", "notional", "underlying", "expiry",
  "strike", "premium", "payout", "binary", "tranche", "basis", "spread",
  "liquidity", "volatility", "arbitrage", "hedging", "leverage", "margin",
  "clearing", "clearinghouse", "custodian", "broker", "dealer", "counterparty",
  "venue", "exchange", "orderbook", "tape", "quote", "bid", "ask", "fill",
  "settlement", "settle", "delivery", "float", "outstanding", "dilution",
  "buyback", "dividend", "yield", "coupon", "maturity", "valuation",
  "portfolio", "position", "exposure", "flow", "pricing", "priced",
  // conduct / offences
  "manipulation", "manipulative", "spoofing", "layering", "churning",
  "frontrunning", "wash", "insider", "fraud", "fraudulent", "misconduct",
  "wrongdoing", "malfeasance", "collusion", "conspiracy", "evasion",
  // legal
  "statute", "statutory", "liability", "liable", "jurisdiction", "precedent",
  "doctrine", "injunction", "subpoena", "indictment", "felony", "misdemeanor",
  "prosecution", "prosecutor", "litigation", "litigate", "defendant",
  "plaintiff", "respondent", "testimony", "deposition", "sanction", "penalty",
  "fine", "forfeiture", "disgorgement", "restitution", "consent", "decree",
  "adjudication", "admission", "unlawful", "lawful", "illegal", "criminal",
  "civil", "compliance", "violation", "infraction", "charge", "count",
  "allegation", "allege", "finding", "hearing", "trial", "verdict", "appeal",
  "counsel", "attorney", "lawyer", "court", "judge", "tribunal", "docket",
  "burden", "standard", "scrutiny", "exemption", "safeharbor", "waiver",
  // institutions & regimes
  "regulator", "regulatory", "regulation", "rulemaking", "agency",
  "commission", "commissioner", "congress", "senate", "legislature",
  "legislation", "committee", "subcommittee", "oversight", "enforcement",
  "supervision", "examination", "audit", "auditor", "registrant",
  "registration", "prospectus", "schedule", "exhibit", "attestation",
  "certification", "selfcertification", "designation", "designated",
  "surveillance", "referral", "whistleblower",
  // actors
  "trader", "investor", "shareholder", "stakeholder", "issuer", "insider",
  "executive", "director", "officer", "congressman", "senator", "legislator",
  "official", "employee", "member", "principal", "adviser", "advisor",
  "fund", "firm", "bank", "banker", "desk",
];

const FREE_STEMS = new Set<string>();
for (const w of RECORD_DEIXIS) FREE_STEMS.add(stem(w));
const DOMAIN_STEMS = new Set<string>();
for (const w of DOMAIN_WORDS) {
  const s = stem(w);
  if (!FREE_STEMS.has(s)) DOMAIN_STEMS.add(s);
}

/** Furniture: attribution vocabulary + calendar, reused from validate.ts's idea. */
const FURNITURE = new Set<string>([
  "SEC", "EDGAR", "BLS", "FDA", "CFTC", "FTC", "FCA", "ECB", "FOMC", "DOJ",
  "NYSE", "OTC", "IPO", "ET", "UTC", "CIK", "CEO", "CFO", "COO", "CTO",
  "GDP", "CPI", "PPI", "PCE", "USD", "EUR", "GBP", "PTR", "EFD", "MPC", "RBI",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

/** Capitalised words that are ordinary English, not entity claims. */
const COMMON_CAPS = new Set<string>([
  "I", "A", "The", "This", "That", "These", "Those", "It", "They", "We",
  "You", "He", "She", "His", "Her", "Their", "Our", "Your", "Its",
  "And", "But", "Or", "So", "Then", "Now", "Here", "There", "When", "Where",
  "What", "Which", "Who", "Why", "How", "If", "Not", "No", "Nobody", "None",
  "Everyone", "Someone", "Somebody", "Nothing", "Something", "Every", "All",
  "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Both", "Second", "First", "Third", "Last", "Past", "Up", "Down",
  "Legal", "Public", "Filed", "Amended", "Complaint", "Allegation", "Timeline",
  "Code", "Scheduled", "Zero", "Four", "Eighty-seven", "Thirty-nine", "Sixty-one",
  "Whatever", "Most", "Today", "Rate", "Nine", "Position", "Three",
]);

export interface ValidationIssue { readonly rule: string; readonly detail: string }

export interface CoverageOptions {
  readonly licensedJson: string;      // facts.json — payload ∪ grounding
  readonly libraryBeats: readonly string[];
  readonly variant: "dry" | "sharp" | "commentary";
}

function normaliseBeat(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function coverageCheck(text: string, opts: CoverageOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const licensed = stems(opts.licensedJson);
  const hay = opts.licensedJson.toLowerCase();
  const beatSet = new Set(opts.libraryBeats.map(normaliseBeat));

  const segments = text.split(/\n+/).slice(1); // everything after the fact block
  for (const seg of segments) {
    for (const sentence of seg.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (s === "") continue;
      if (beatSet.has(normaliseBeat(s))) continue; // LIBRARY EXEMPTION

      // (a) DOMAIN COVERAGE
      const toks = s.split(/[^A-Za-z0-9$'-]+/).filter(Boolean);
      for (const t of toks) {
        const st = stem(t);
        if (!DOMAIN_STEMS.has(st)) continue;
        if (licensed.has(st)) continue;
        issues.push({ rule: "coverage", detail: `domain term "${t}" is not stated in the payload, source or lake context` });
      }

      // (b) PROPER NOUNS, including single tokens
      toks.forEach((t, i) => {
        if (!/^[A-Z][a-z'-]+$/.test(t) && !/^[A-Z]{2,}$/.test(t)) return;
        if (i === 0) return;              // sentence-initial
        if (FURNITURE.has(t)) return;
        if (COMMON_CAPS.has(t)) return;
        if (new RegExp(`(?<![A-Za-z0-9])${t}(?![A-Za-z0-9])`, "i").test(hay)) return;
        issues.push({ rule: "coverage", detail: `proper noun "${t}" is not in the licensed universe` });
      });

      // (c) QUOTED SPANS >= 3 words
      for (const m of s.matchAll(/["“'']([^"”'']{3,})["”'']/g)) {
        const span = m[1]!.trim();
        if (span.split(/\s+/).length < 3) continue;
        const needle = span.toLowerCase().replace(/\s+/g, " ");
        if (!hay.replace(/\s+/g, " ").includes(needle)) {
          issues.push({ rule: "coverage", detail: `quoted span "${span.slice(0, 40)}" does not appear verbatim in the licensed universe` });
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// CORPORA
// ---------------------------------------------------------------------------

const CFTC_PAYLOAD: Payload = {
  authority: "CFTC",
  title: "CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
  categories: [],
  publishedIso: "2026-07-31T19:26:52.000Z",
  factLine: "CFTC: CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
} as unknown as Payload;

const CFTC_LAKE = [
  "9 prior CFTC items via press_cftc_enforcement in our lake since 2026-04-23.",
  'Prior: "CFTC Charges Service Member with Manipulative Trading of Nicolas Maduro-Related Event Contracts" (2026-05-14).',
  'Prior: "CFTC Obtains Judgment Against Pool Operator for Fraud" (2026-05-02).',
].join("\n");

const FABRICATED: Array<[string, string]> = [
  ["C1 legal", "Event contracts face identical manipulation scrutiny to cash-settled derivatives."],
  ["C1 legal", "Manipulation liability does not require the trade to have moved a price."],
  ["C1 legal", "A civil penalty of this kind carries no admission of wrongdoing."],
  ["C1 legal", "The statute reaches attempted manipulation even where no counterparty lost money."],
  ["C2 bio", "Santos once sat through State-of-the-Union addresses as a member of Congress."],
  ["C2 bio", "The respondent is a former congressman, which is why the contract is interesting."],
  ["C2 bio", "He left the House long before this contract was ever listed."],
  ["C2 bio", "Santos has been sanctioned before, in a different forum entirely."],
  ["C3 hist", "This is the first manipulation order over a political event contract."],
  ["C3 hist", "Event-contract enforcement was running long before this order landed."],
  ["C3 hist", "The last comparable order came out of the energy markets."],
  ["C4 causal", "The order landed because the exchange flagged the account itself."],
  ["C4 causal", "Volume in the contract dried up once the complaint was filed."],
  ["C4 causal", "Scrutiny arrived the moment the contract started drawing political money."],
  ["C4 causal", "The penalty is small because the position never got large."],
  ["C5 absence", "No exchange was charged alongside the trader."],
  ["C5 absence", "Nobody else has been penalized over a State-of-the-Union contract."],
  ["C5 absence", "There is no criminal case attached to this one."],
  ["C5 absence", "The order names no counterparties and no venue."],
  ["C6 instbeh", "Regulators treat official outcomes as closed markets."],
  ["C6 instbeh", "Enforcement desks reach for event contracts only after the outcome is already public."],
  ["C6 instbeh", "The agency settles these matters far more often than it litigates them."],
  ["C6 instbeh", "This is the kind of order the Commission signs without ever holding a hearing."],
  ["C7 stance", "Santos has not responded to the order."],
  ["C7 stance", "The exchange that listed the contract declined to comment."],
  ["C7 stance", "The agency says more cases are in the pipeline."],
  ["C8 prevalence", "Most manipulation cases never name an individual trader."],
  ["C8 prevalence", "Orders this small are rare enough to be worth noticing."],
  ["C8 prevalence", "Almost every event-contract case so far has ended in a settlement."],
  ["C8 prevalence", "Individual respondents are the exception in this program."],
  ["C9 mechanism", "Event contracts settle against the official outcome and nothing else."],
  ["C9 mechanism", "These contracts trade on a designated contract market, not an exchange floor."],
  ["C9 mechanism", "A binary payout means the target is the outcome, not the price path."],
  ["C9 mechanism", "Event contracts get listed by self-certification, so nobody approves them in advance."],
  ["C10 intent", "The agency is drawing a line before the midterm contracts list."],
  ["C10 intent", "This order exists to be cited in the next one."],
  ["C10 intent", "The point of the penalty is the precedent, not the money."],
  ["C10 intent", "Someone wanted this on the books before the next election cycle."],
  ["C11 comparative", "That penalty is small change next to a typical manipulation fine."],
  ["C11 comparative", "Bigger numbers get handed out for paperwork failures."],
  ["C11 comparative", "By enforcement standards this is a parking ticket."],
  ["C11 comparative", "The sum would not cover a week of defense counsel."],
  ["C12 counterfactual", "Had the contract been a security, a different agency would have brought this."],
  ["C12 counterfactual", "A trader doing this in a grain market would have drawn a bigger number."],
  ["C12 counterfactual", "If the outcome had gone the other way there would be no order at all."],
  ["C13 analogy", "This is insider trading with a ballot box instead of an earnings call."],
  ["C13 analogy", "Same playbook as painting the tape, different underlying."],
  ["C13 analogy", "Call it wash trading in a costume."],
  ["C14 predictive", "More of these orders are coming before the midterms."],
  ["C14 predictive", "The next election cycle will produce a bigger version of this case."],
  ["C14 predictive", "Expect the exchanges to tighten their surveillance language after this."],
  ["C15 lakeinf", "That makes this the busiest stretch of event-contract enforcement on record."],
  ["C15 lakeinf", "The pace of these orders has not let up all year."],
  ["C15 lakeinf", "This authority has been unusually busy in this corner of the market."],
  ["ENTITY hole", "Kalshi listed the contract and kept listing it."],
  ["ENTITY hole", "The contract traded on Polymarket until the order landed."],
];

function libraryBeatsFor(archetype: string): string[] {
  const a = (ARCHETYPES as Record<string, { beats?: Array<{ text: string }> }>)[archetype];
  return (a?.beats ?? []).map((b) => b.text);
}

describe("coverage probe", () => {
  it("fabricated corpus", () => {
    const licensed = `${JSON.stringify(CFTC_PAYLOAD)}\n${CFTC_LAKE}`;
    let caught = 0;
    const lines: string[] = [];
    for (const [cls, sentence] of FABRICATED) {
      const draft = `CFTC ordered a $35,000 penalty, per CFTC.\n\n${sentence}`;
      const issues = coverageCheck(draft, { licensedJson: licensed, libraryBeats: libraryBeatsFor("REGULATORY_NEWS"), variant: "commentary" });
      if (issues.length > 0) caught++;
      lines.push(`${issues.length > 0 ? "CATCH" : "MISS "} [${cls}] ${sentence}\n        ${issues.map((i) => i.detail).join(" | ")}`);
    }
    console.log(`\n=== FABRICATED: ${caught}/${FABRICATED.length} caught ===`);
    console.log(lines.join("\n"));
  });

  it("owner exemplar corpus", () => {
    let flagged = 0;
    const lines: string[] = [];
    OWNER_EXEMPLARS.forEach((ex, idx) => {
      const segs = ex.text.split(/\n+/);
      const factBlock = segs[0]!;
      // Most generous plausible payload: every word of the fact block is a parsed field.
      const payload = { title: factBlock, factLine: factBlock, authority: "SEC" } as unknown as Payload;
      const licensed = JSON.stringify(payload);
      const issues = coverageCheck(ex.text, {
        licensedJson: licensed,
        libraryBeats: libraryBeatsFor(ex.archetype),
        variant: ex.register === "commentary" ? "commentary" : "dry",
      });
      if (issues.length > 0) flagged++;
      lines.push(`${issues.length > 0 ? "FLAG " : "pass "} E${idx + 1} ${ex.archetype}/${ex.register}\n        ${segs.slice(1).join(" / ")}\n        ${issues.map((i) => i.detail).join(" | ")}`);
    });
    console.log(`\n=== OWNER EXEMPLARS: ${flagged}/${OWNER_EXEMPLARS.length} FLAGGED (false positives) ===`);
    console.log(lines.join("\n"));
  });

  it("live beat library", () => {
    let flagged = 0;
    const all: string[] = [];
    for (const [id, a] of Object.entries(ARCHETYPES as Record<string, { beats?: Array<{ text: string }> }>)) {
      for (const b of a.beats ?? []) {
        const draft = `Something happened, per SEC.\n\n${b.text.replace(/\{[^}]+\}/g, "7")}`;
        const payload = { title: "Something happened", factLine: "Something happened", authority: "SEC" } as unknown as Payload;
        // library exemption OFF on purpose: measure the raw rule
        const issues = coverageCheck(draft, { licensedJson: JSON.stringify(payload), libraryBeats: [], variant: "dry" });
        if (issues.length > 0) { flagged++; all.push(`FLAG [${id}] ${b.text}\n        ${issues.map((i) => i.detail).join(" | ")}`); }
      }
    }
    console.log(`\n=== LIVE BEATS (no library exemption): ${flagged} flagged ===`);
    console.log(all.join("\n"));
  });
});
