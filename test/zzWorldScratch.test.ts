import { describe, expect, it } from "vitest";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";
import { ARCHETYPES } from "../src/templates/archetypes";
import type { ArchetypeId } from "../src/templates/types";

// SCRATCH — measurement harness for the unsourced-world-knowledge design.
// Deleted before the answer ships. Nothing here is a proposed test.

// ---------------------------------------------------------------------------
// Candidate implementation: UNLICENSED DOMAIN TERM
// ---------------------------------------------------------------------------

const DOMAIN_LEXICON: readonly string[] = [
  // A. legal / doctrinal
  "liability", "liable", "statute", "statutory", "jurisdiction", "precedent",
  "doctrine", "unlawful", "illegal", "felony", "misdemeanor", "indictment",
  "admission", "wrongdoing", "culpability", "scienter", "fiduciary",
  "safe harbor", "no-action", "injunction", "consent decree", "tort",
  "negligence", "burden of proof", "due process", "statute of limitations",
  "criminal", "civil penalty", "prosecution", "prosecuted", "convicted",
  "legally", "law", "laws", "regulation", "regulations", "rulemaking",
  // B. institution classes (generic, not a named payload authority)
  "regulators", "regulator", "watchdog", "watchdogs", "prosecutors",
  "courts", "commissions", "agencies", "lawmakers", "legislators",
  "congress", "senate", "parliament", "enforcement desks", "the bench",
  // C. instrument / market structure
  "derivatives", "derivative", "futures", "swaps", "swap", "equities",
  "securities", "commodities", "counterparty", "counterparties",
  "clearinghouse", "clearing", "designated contract market", "self-certification",
  "settlement mechanics", "binary payout", "order book", "market maker",
  "liquidity", "spread", "spreads", "open interest", "hedging", "hedge fund",
  "arbitrage", "underlying", "venue", "venues", "exchange floor",
  "cash-settled", "over-the-counter", "listing standards", "tick size",
  // D. market behaviour / pricing
  "priced", "repriced", "pricing", "valuation", "rally", "selloff",
  "sentiment", "positioning", "volatility", "flows", "the tape",
  // E. enforcement process
  "subpoena", "deposition", "plea", "referral", "sanction", "sanctioned",
  "disgorgement", "restitution", "cease-and-desist", "administrative proceeding",
  "enforcement action", "enforcement actions", "enforcement regime",
  "settle", "settled", "settlement", "litigate", "litigated", "litigation",
  // F. role / biography
  "congressman", "congresswoman", "senator", "representative", "lawmaker",
  "commissioner", "chairman", "incumbent", "former", "member of congress",
];

function stem(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(sses|ches|shes|xes)$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(stem)
    .join(" ")} `;
}

interface Result {
  readonly hits: string[];
}

function domainCheck(text: string, licensed: string): Result {
  const draft = normalise(text);
  const hay = normalise(licensed);
  const hits: string[] = [];
  for (const term of DOMAIN_LEXICON) {
    const needle = normalise(term).trim();
    if (!draft.includes(` ${needle} `)) continue;
    if (hay.includes(` ${needle} `)) continue;
    hits.push(term);
  }
  return { hits };
}

// ---------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------

const CFTC_PAYLOAD = JSON.stringify({
  authority: "CFTC",
  title:
    "CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
  categories: [],
  publishedIso: "2026-07-31T19:26:52.000Z",
  factLine:
    "CFTC: CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
});

// The four real cases from the brief plus the verified floor-passing set.
const FABRICATED: ReadonlyArray<[string, string]> = [
  ["gen34-legal", "Event contracts face identical manipulation scrutiny to cash-settled derivatives."],
  ["gen33-institutional", "Regulators treat official outcomes as closed markets."],
  ["reviewer-biographical", "Santos once sat through State-of-the-Union addresses as a member of Congress."],
  ["legal-2", "Manipulation liability does not require the trade to have moved a price."],
  ["legal-3", "A civil penalty of this kind carries no admission of wrongdoing."],
  ["legal-4", "The statute reaches attempted manipulation even where no counterparty lost money."],
  ["mechanism-1", "Event contracts settle against the official outcome and nothing else."],
  ["mechanism-2", "These contracts trade on a designated contract market, not an exchange floor."],
  ["mechanism-3", "Event contracts get listed by self-certification, so nobody approves them in advance."],
  ["institutional-2", "The agency settles these matters far more often than it litigates them."],
  ["institutional-3", "Enforcement desks reach for event contracts only after the outcome is already public."],
  ["absence-1", "No exchange was charged alongside the trader."],
  ["absence-2", "Nobody else has been penalized over a State-of-the-Union contract."],
  ["absence-3", "The order names no counterparties and no venue."],
  ["comparative-1", "That penalty is small change next to a typical manipulation fine."],
  ["comparative-2", "By enforcement standards this is a parking ticket."],
  ["counterfactual-1", "Had the contract been a security, a different agency would have brought this."],
  ["historical-1", "This is the first manipulation order over a political event contract."],
  ["historical-2", "The last comparable order came out of the energy markets."],
  ["stance-1", "The exchange that listed the contract declined to comment."],
  ["biographical-2", "The respondent is a former congressman, which is why the contract is interesting."],
  ["intent-1", "The point of the penalty is the precedent, not the money."],
  ["prevalence-1", "Most manipulation cases never name an individual trader."],
  ["analogy-1", "This is insider trading with a ballot box instead of an earnings call."],
  ["predictive-1", "More of these orders are coming before the midterms."],
];

/** Take sentences = everything after the first line of an owner exemplar. */
function takeOf(text: string): string {
  const lines = text.split(/\n+/).filter((l) => l.trim() !== "");
  return lines.slice(1).join(" ");
}
function factBlockOf(text: string): string {
  return text.split(/\n+/).filter((l) => l.trim() !== "")[0] ?? "";
}

function beatsFor(a: ArchetypeId): string {
  return (ARCHETYPES[a]?.beats ?? []).map((b) => b.text).join(" ");
}

describe("SCRATCH: unlicensed domain term", () => {
  it("recall against the fabricated corpus", () => {
    const missed: string[] = [];
    const caught: string[] = [];
    for (const [id, sentence] of FABRICATED) {
      const r = domainCheck(sentence, CFTC_PAYLOAD);
      if (r.hits.length === 0) missed.push(id);
      else caught.push(`${id} <- ${r.hits.join(",")}`);
    }
    console.log(`\n=== RECALL: ${caught.length}/${FABRICATED.length} caught ===`);
    for (const c of caught) console.log(`  CAUGHT ${c}`);
    console.log(`--- MISSED (${missed.length}) ---`);
    for (const m of missed) console.log(`  MISS   ${m}`);
    expect(true).toBe(true);
  });

  it("false positives against OWNER_EXEMPLARS (take sentences only)", () => {
    let fpNoBeats = 0;
    let fpWithBeats = 0;
    const rows: string[] = [];
    for (const ex of OWNER_EXEMPLARS) {
      const take = takeOf(ex.text);
      const fact = factBlockOf(ex.text);
      const bare = domainCheck(take, fact);
      const withBeats = domainCheck(take, `${fact} ${beatsFor(ex.archetype)}`);
      if (bare.hits.length > 0) fpNoBeats += 1;
      if (withBeats.hits.length > 0) {
        fpWithBeats += 1;
        rows.push(`  FP  [${ex.archetype}/${ex.register}] ${withBeats.hits.join(",")} :: ${take.slice(0, 110)}`);
      }
    }
    console.log(`\n=== FALSE POSITIVES over ${OWNER_EXEMPLARS.length} exemplars ===`);
    console.log(`  fact-block licensing only : ${fpNoBeats}`);
    console.log(`  + beat-library exemption  : ${fpWithBeats}`);
    for (const r of rows) console.log(r);
    expect(true).toBe(true);
  });

  it("false positives against every LIVE beat in archetypes.ts", () => {
    const rows: string[] = [];
    let n = 0;
    for (const [id, a] of Object.entries(ARCHETYPES)) {
      for (const b of a.beats) {
        n += 1;
        // Licensed set = payload-ish proxy: the beat library itself is the
        // allowlist, so measure what the check says WITHOUT that exemption.
        const r = domainCheck(b.text, "");
        if (r.hits.length > 0) rows.push(`  BEAT-FP [${id}] ${r.hits.join(",")} :: ${b.text}`);
      }
    }
    console.log(`\n=== LIVE BEATS flagged without the library exemption: ${rows.length}/${n} ===`);
    for (const r of rows) console.log(r);
    expect(true).toBe(true);
  });
});
