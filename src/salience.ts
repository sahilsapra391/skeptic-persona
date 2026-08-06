import type { ArchetypeId, Payload } from "./templates/types";

// SALIENCE — how much a parsed item asks for the owner's attention.
//
// WHAT THIS IS, doctrinally: a SELECTION heuristic on parsed fields. It
// decides what reaches the approval queue and never appears in a post, so a
// wrong score costs a queue slot, not a false statement (persona.md §"that
// filter is a SELECTION heuristic ... never a claim"). Nothing here may be
// quoted, rendered, or implied in copy.
//
// WHY IT EXISTS (measured 2026-08-01 against production D1, 5 weekdays):
//   918 cards, 181/day, against a 25/day target — 7.2x.
//   20 true approvals lifetime = 2.18%, and 19 of those 20 landed inside the
//   ~6h window when Approve still auto-posted to Threads. The three full days
//   2026-07-29..31 produced 488 cards and ZERO approvals.
// The flood is NOT what the plan assumed. Reg SHO — the named "mechanical
// noise" — is 12 of 918 cards (1.3%, ~4/day). The actual flood is four
// mechanical sub-classes inside otherwise good sources:
//   8-K item 5.02 (officer/director changes): 83 of ~106 post-gate cards, 0 approvals
//   HALT volatility pauses (LUDP + M):        191 of 219 cards, reasonText "Volatility Trading Pause"
//   13D/G amendments:                          64 of 86 OWNERSHIP_STAKE cards
//   Form 144 small-dollar notices:             95 of 157 cards under $5M
//
// HOW THE BASES WERE SET, and the constraint on them: the engagement study
// (docs/verification/2026-07-28-competitor-topic-engagement.md) explicitly
// FORBIDS importing its ratios as coefficients — "ratios transfer
// directionally, not numerically ... treated as a tie-breaker on ordering,
// never imported as coefficients". So the bases below encode only the
// measured ORDERING (congress > enforcement > insider > macro > rates) as
// ordinal tiers. The 1.67x/1.13x/0.56x numbers appear nowhere in this file.
// Categories the study could not measure (halt, recall: n < 25) are placed
// mid-tier and marked UNMEASURED — absence of evidence is not evidence of
// low value, and the honest place to break the tie is our own post_log once
// it has volume.

/** Ordinal category bases. Ordering-derived (see header), never coefficients. */
const CATEGORY_BASE: Record<string, number> = {
  // Measured strongest, and our own flagship. Also currently starved: zero
  // cards ever, because the relay only went live 2026-08-01.
  CONGRESS_PTR: 90,
  // Measured second (enforcement).
  REGULATORY_NEWS: 70,
  POLICY_ACTION: 65,
  // Measured third (insider).
  INSIDER_CLUSTER: 62,
  FILING_FORM4: 58,
  INSIDER_NOTICE: 55,
  // CFTC positioning: 2 of 8 approved locally, the second-best rate we have.
  // An earlier base of 32 read this as price/tape and was simply wrong.
  POSITIONING: 55,
  // UNMEASURED in the study (n < 25) or absent from it — mid tier by honesty,
  // discriminated by magnitude below rather than by base.
  FILING_8K: 50,
  OWNERSHIP_STAKE: 50,
  PRODUCT_RECALL: 50,
  DELISTING: 50,
  STORM: 45,
  SETTLEMENT_FAILURE: 46,
  HALT: 40,
  // The four below sit AT OR ABOVE the floor on purpose. Review found that a
  // base under DEFAULT_SALIENCE_FLOOR with no magnitude branch means the
  // category can NEVER reach the queue for any payload — CPI, the jobs
  // report, every Fed release and every sub-50bp rate decision would have
  // been reachable only in a 21:00 ET roll-up, up to 12.5h after an 08:30 ET
  // print, while the committed TTLs give MACRO_PRINT 12h precisely because it
  // is time-critical. Their ingesters already gate hard (BLS posts only a
  // real release; rates queue only on a CHANGE vs prior; Treasury only on a
  // completed auction), so re-suppressing here double-counts a filter that
  // has already run. `noCategoryBelowFloor` in the tests pins this.
  FED_PRESS: 50,
  TREASURY_AUCTION: 50,
  MACRO_PRINT: 55,
  RATE_DECISION: 50,
};

const DEFAULT_BASE = 40;

/** Categories the owner exempted from the daily ceiling (amendment 2026-08-01):
 *  "a hard cap that drops a congress PTR because a quiet category already
 *  filled the day is the failure mode to avoid." */
export const CEILING_EXEMPT: ReadonlySet<string> = new Set(["CONGRESS_PTR", "REGULATORY_NEWS", "POLICY_ACTION"]);

/**
 * REGULATORY_NEWS content tiers (p5-03b, owner ruling 2026-08-06 extending the
 * BEA/ONS precedent).
 *
 * THE RULING, verbatim: "tier follows content type, not source."
 *
 *   ENFORCEMENT     an action naming a market entity. Card-eligible.
 *   MACRO           an actual data print. Card-eligible, salience decides.
 *   POLICY          a policy decision. Digest by default; cards only on a
 *                   change from prior, a surprise, or an unscheduled action.
 *   ADMINISTRATIVE  circulars, consultations, speeches, minutes, calendars,
 *                   appointments, appeal dockets. LEDGER ONLY, never a card.
 *   NON_MARKET      DOJ press with no market subject. Ledger only, and
 *                   explicitly NOT digest: it does not belong in a finance
 *                   digest at all.
 *
 * WHY TITLE-MATCHING IS DEFENSIBLE HERE, given this repo's distrust of regex
 * on prose: the classifier never licenses a FACT. It decides which queue an
 * item joins, which is a selection heuristic exactly like the rest of this
 * file, and persona.md's rule is that a wrong score costs a queue slot and
 * never a false statement. Nothing it produces reaches copy.
 *
 * EVERY PATTERN BELOW WAS WRITTEN AGAINST REAL PENDING TITLES read from
 * production on 2026-08-06, not imagined. The DOJ default is the clearest
 * case: of the DOJ items in the queue that day, the sample was laser strikes
 * on police helicopters, a county voting-rights suit, denaturalization cases,
 * a fatal collision guilty plea and a child-pornography sentencing. Five of
 * five had no market subject.
 */
export type RegulatoryNewsTier =
  | "ENFORCEMENT"
  | "MACRO"
  | "POLICY"
  | "ADMINISTRATIVE"
  | "NON_MARKET"
  | "DATA_PRINT"
  | "RELEASE_CALENDAR";

/** The BEA/ONS precedent this ruling extends. Kept keyed on authority because
 *  each of these sources is wholly one content type: ONS's endpoint IS a
 *  release calendar, BEA's feed IS the statistical releases. */
export const REGULATORY_NEWS_TIER: Readonly<Record<string, RegulatoryNewsTier>> = {
  "Bureau of Economic Analysis": "DATA_PRINT",
  "UK ONS": "RELEASE_CALENDAR",
};

const rx = (...parts: string[]) => new RegExp(parts.join("|"), "i");

/** DOJ is POSITIVE-MATCH ONLY: the default is NON_MARKET, so a pattern miss
 *  costs a ledger entry and never a bad card. The owner's list, one clause
 *  each: securities or commodities fraud, antitrust involving public
 *  companies, FCPA, sanctions, financial-institution cases. */
const DOJ_MARKET = rx(
  "securities fraud", "commodit(?:y|ies) fraud", "insider trading", "market manipulation",
  "investment fraud", "ponzi", "securities and exchange commission",
  "antitrust", "monopol", "price[- ]fixing", "bid[- ]rigging",
  "foreign corrupt practices", "\\bFCPA\\b",
  "sanctions", "\\bOFAC\\b", "export control",
  "financial institution", "\\bbank fraud\\b", "money laundering",
);

/** Administrative output, shared across authorities: it names no event. */
const ADMIN = rx(
  "\\bminutes\\b", "\\bspeech\\b", "\\bremarks\\b", "research paper", "\\breview\\b",
  "\\bcircular\\b", "consultation", "invites public comments", "draft guidelines",
  "\\bappeal no\\b", "\\bappointment", "calendar", "\\bagenda\\b", "working paper",
  // PROCEDURAL CIRCULARS, added after the tier ruling's first live catch.
  // RBI #919 was "Reporting of FCNR(B) Deposits, External Commercial
  // Borrowings and Overseas Foreign Currency Borrowings mobilized under
  // Reserve Bank's Swap Facility" — a circular about HOW TO REPORT, which the
  // DATA matcher caught on "swap facility" and tiered as a macro print. An
  // owner draft then stated "$40.82B" against a payload with no numeric field
  // at all. The document class, not the subject, decides the tier.
  "\\breporting of\\b", "\\bmaster direction\\b", "\\bnotification\\b",
  "\\bframework\\b", "\\bamendment to\\b", "\\bguidelines\\b", "\\bFAQ",
);

/** A data print: the release itself, carrying figures. */
const DATA = rx(
  "\\baccounts\\b", "\\bbalances\\b", "\\bcollateral\\b", "\\bheld by\\b",
  "\\bauction\\b", "money market operations",
  "releases data", "\\breserves\\b", "swap facility", "\\bprojections\\b",
);

/** Policy: a decision, or the statement that carries one. */
const POLICY = rx("monetary policy", "policy statement", "statement on .*polic", "resolution of the monetary policy");

/**
 * The three things that lift a POLICY item to card-eligible, per the ruling:
 * a change from prior, a surprise, or an unscheduled action. SPLIT IN TWO,
 * because they are not equally unambiguous.
 *
 * URGENT words mean the same thing wherever they appear, so they are checked
 * before anything else and can rescue a title the shape-matchers would bury.
 *
 * CHANGE VERBS only mean a policy change INSIDE a policy title. Checked first
 * and globally, "changes" matched "Sources of Changes in Current Account
 * Balances", promoting a routine BoJ data print to enforcement tier. The
 * real-title test caught it; the fix is scope, not a longer pattern.
 */
const POLICY_URGENT = rx("unscheduled", "emergency", "intervention", "intervene");
const POLICY_CHANGED = rx("\\braises?\\b", "\\blowers?\\b", "\\bcuts?\\b", "\\bhikes?\\b", "\\bchange[sd]?\\b");

/** An enforcement order aimed at an entity rather than a person or a docket. */
const SEBI_ENFORCEMENT = rx("\\border\\b", "adjudicat", "settlement order", "\\bdirections\\b");
/** Individuals and dockets are not listed entities. */
const SEBI_NOT_ENTITY = rx("\\bappeal no\\b", "\\bHUF\\b", "\\bMr\\.", "\\bMs\\.", "\\bShri\\b", "in respect of Mr");

/**
 * Classify one REGULATORY_NEWS item. Returns undefined when the authority has
 * no ruling, which leaves that source's behaviour exactly as it is today.
 */
export function classifyRegulatoryNews(authority: string, title: string): RegulatoryNewsTier | undefined {
  const preset = REGULATORY_NEWS_TIER[authority];
  if (preset) return preset;

  switch (authority) {
    case "DOJ":
      // Positive-match only. Everything else is criminal or civil news with no
      // market subject, and the owner ruled it out of the digest entirely.
      return DOJ_MARKET.test(title) ? "ENFORCEMENT" : "NON_MARKET";

    case "Bank of Japan":
      // Checked FIRST, before the administrative sweep. An intervention or an
      // unscheduled action is card-worthy whatever shape the title takes, and
      // the owner named those explicitly. Ordering this after ADMIN sent
      // "announces intervention in the foreign exchange market" to the ledger,
      // which the real-title test caught.
      if (POLICY_URGENT.test(title)) return "ENFORCEMENT";
      if (ADMIN.test(title)) return "ADMINISTRATIVE";
      if (DATA.test(title)) return "MACRO";
      if (POLICY.test(title)) return POLICY_CHANGED.test(title) ? "ENFORCEMENT" : "POLICY";
      return "ADMINISTRATIVE";

    case "Reserve Bank of India":
      if (POLICY_URGENT.test(title)) return "ENFORCEMENT";
      if (ADMIN.test(title)) return "ADMINISTRATIVE";
      if (DATA.test(title)) return "MACRO";
      if (POLICY.test(title)) return POLICY_CHANGED.test(title) ? "ENFORCEMENT" : "POLICY";
      // "Directions under Section 35A ... Banking Regulation Act" is an action
      // against a bank, which is a financial-institution case by any reading.
      if (/directions under/i.test(title)) return "ENFORCEMENT";
      return "ADMINISTRATIVE";

    case "SEBI":
      if (SEBI_NOT_ENTITY.test(title)) return "ADMINISTRATIVE";
      if (ADMIN.test(title)) return "ADMINISTRATIVE";
      return SEBI_ENFORCEMENT.test(title) ? "ENFORCEMENT" : "ADMINISTRATIVE";

    default:
      return undefined;
  }
}

export interface Salience {
  /** 0-100. Higher asks louder. */
  score: number;
  /** Machine-readable reasons, for the replay report and the weekly digest. */
  reasons: string[];
  /** True when this category ignores the daily ceiling. */
  exempt: boolean;
  /** LEDGER ONLY: never a card and never a digest line. The item is marked
   *  'logged' rather than 'digested', because 'digested' means it met the bar
   *  and lost a slot, and these never met any bar. Set by the REGULATORY_NEWS
   *  ADMINISTRATIVE and NON_MARKET tiers (owner ruling 2026-08-06). */
  ledgerOnly: boolean;
}

function num(payload: Payload, key: string): number | null {
  const v = payload[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function nested(payload: Payload, path: readonly string[]): number | null {
  let cur: unknown = payload;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  return null;
}

/** 8-K item codes, weighted by what the filing actually discloses. The
 *  QUEUEABLE_ITEMS gate in edgar8k.ts already decides admission; this only
 *  ranks what got in. 5.02 dominates volume (83 of ~106 post-gate cards) and
 *  has never once been approved, so it is demoted, not banned — a CEO
 *  departure and a routine director appointment share the code, and the code
 *  is all we parse. */
const ITEM_WEIGHT: Record<string, number> = {
  "1.03": 45, // bankruptcy or receivership
  "4.02": 45, // non-reliance on previously issued financials (restatement)
  "1.05": 35, // material cybersecurity incident
  "2.04": 30, // triggering events accelerating an obligation
  "2.06": 30, // material impairment
  "5.01": 25, // change in control
  "3.01": 20, // delisting notice / listing-standard failure
  "5.02": -15, // officer/director change: the volume, never approved
};

/** Halt reason codes. The volatility pauses are the flood (LUDP + M = 191 of
 *  219 cards); T1 "News Pending" is the one that reliably means something. */
const HALT_WEIGHT: Record<string, number> = {
  T1: 30, // news pending
  T2: 25, // news released
  T12: 30, // additional information requested
  H11: 30, // regulatory concern
  H10: 25,
  LUDP: -20, // volatility trading pause
  M: -20, // volatility trading pause (NYSE)
  T3: -25, // news and resumption — lake-only by prior decision
};

/**
 * Score one parsed item. Pure: no I/O, no clock, no D1 — the replay harness
 * and the live gate must agree exactly.
 */
export function salienceFor(archetype: ArchetypeId | string, payload: Payload): Salience {
  const base = CATEGORY_BASE[archetype] ?? DEFAULT_BASE;
  const reasons: string[] = [`base:${archetype}=${base}`];
  let magnitude = 0;
  /** Set by the REGULATORY_NEWS case; also decides the ceiling exemption. */
  let regNewsTier: RegulatoryNewsTier | undefined;

  switch (archetype) {
    case "FILING_8K": {
      // payload.items is [{code, title}, ...] — verified against live rows;
      // it is NOT an array of strings.
      const items = Array.isArray(payload["items"]) ? (payload["items"] as unknown[]) : [];
      let best = 0;
      let bestCode = "";
      for (const it of items) {
        const code = typeof it === "string" ? it : ((it as Record<string, unknown> | null)?.["code"] as string | undefined);
        if (typeof code !== "string") continue;
        const w = ITEM_WEIGHT[code];
        if (w !== undefined && (bestCode === "" || w > best)) {
          best = w;
          bestCode = code;
        }
      }
      if (bestCode) {
        magnitude += best;
        reasons.push(`8k.item:${bestCode}=${best}`);
      }
      break;
    }
    case "HALT": {
      const code = typeof payload["reasonCode"] === "string" ? (payload["reasonCode"] as string) : "";
      const w = HALT_WEIGHT[code];
      if (w !== undefined) {
        magnitude += w;
        reasons.push(`halt.reason:${code}=${w}`);
      }
      break;
    }
    case "INSIDER_NOTICE": {
      // Form 144 proposed-sale value. Verified field: aggregateMarketValue
      // (present on 157/157 live cards). Distribution: 95 under $5M.
      const v = num(payload, "aggregateMarketValue");
      if (v !== null) {
        const w = v >= 100_000_000 ? 35 : v >= 25_000_000 ? 25 : v >= 5_000_000 ? 5 : -20;
        magnitude += w;
        reasons.push(`n144.value:${Math.round(v)}=${w}`);
      }
      break;
    }
    case "FILING_FORM4": {
      // Verified: payload.totals.buyValue / sellValue. There is NO
      // payload.totals.value — an earlier guess at that name would have
      // silently scored every Form 4 as zero.
      const buy = nested(payload, ["totals", "buyValue"]) ?? 0;
      const sell = nested(payload, ["totals", "sellValue"]) ?? 0;
      const v = Math.max(buy, sell);
      if (v > 0) {
        const w = v >= 10_000_000 ? 30 : v >= 1_000_000 ? 18 : v >= 250_000 ? 5 : -12;
        magnitude += w;
        reasons.push(`form4.value:${Math.round(v)}=${w}`);
      }
      if (buy > 0 && buy >= sell) {
        magnitude += 8; // open-market buying is the rarer, more-read signal
        reasons.push("form4.buySide=8");
      }
      break;
    }
    case "OWNERSHIP_STAKE": {
      // Verified field: topPercent (percentOfClass does not exist).
      const pct = num(payload, "topPercent");
      if (pct !== null) {
        const w = pct >= 15 ? 25 : pct >= 10 ? 15 : pct >= 5 ? 5 : -5;
        magnitude += w;
        reasons.push(`stake.pct:${pct}=${w}`);
      }
      // Doctrine already refuses a beat on an amendment (persona.md never-list);
      // 64 of 86 live cards were amendments. Demote hard rather than ban: a
      // 13D/A that moves a stake materially is still the story.
      if (payload["isAmendment"] === true || payload["isAmendment"] === 1) {
        magnitude -= 25;
        reasons.push("stake.amendment=-25");
      }
      break;
    }
    case "PRODUCT_RECALL": {
      const cls = String(payload["classification"] ?? "");
      if (/Class I\b/i.test(cls)) {
        magnitude += 20;
        reasons.push("recall.classI=20");
      }
      break;
    }
    case "RATE_DECISION": {
      // Rates already queue only on a change (rates.ts); size the move.
      const bps = num(payload, "changeBps");
      if (bps !== null && Math.abs(bps) >= 50) {
        magnitude += 20;
        reasons.push(`rate.bps:${bps}=20`);
      }
      break;
    }
    case "REGULATORY_NEWS": {
      const authority = typeof payload["authority"] === "string" ? (payload["authority"] as string) : "";
      const title = typeof payload["title"] === "string" ? (payload["title"] as string) : "";
      regNewsTier = classifyRegulatoryNews(authority, title);
      switch (regNewsTier) {
        case "ENFORCEMENT":
          // The tier the owner's ceiling exemption was actually written for.
          // Base 70 is already the measured enforcement tier, so this is the
          // one branch that changes no number: it just says so out loud.
          reasons.push("regnews.tier:ENFORCEMENT");
          break;
        case "MACRO":
        case "DATA_PRINT":
          // "Card-eligible with salience deciding": land exactly on the MACRO
          // base rather than near it, using a number that already exists.
          magnitude += CATEGORY_BASE["MACRO_PRINT"]! - base;
          reasons.push(`regnews.tier:${regNewsTier}=MACRO_PRINT(${CATEGORY_BASE["MACRO_PRINT"]})`);
          break;
        case "POLICY":
        case "RELEASE_CALENDAR":
          // Digest by default. Zero is the structural bottom of the scale, a
          // statement that this never asks for attention, rather than a tuned
          // distance below the floor that nobody could justify.
          magnitude -= base;
          reasons.push(`regnews.tier:${regNewsTier}=digest_only`);
          break;
        case "ADMINISTRATIVE":
        case "NON_MARKET":
          magnitude -= base;
          reasons.push(`regnews.tier:${regNewsTier}=ledger_only`);
          break;
        default:
          break;
      }
      break;
    }
    default:
      break;
  }

  const score = Math.max(0, Math.min(100, base + magnitude));
  // EXEMPT FROM THE TIER, not from the archetype. The owner's amendment
  // exempted "enforcement actions"; REGULATORY_NEWS was merely the nearest
  // code-level proxy when press was six enforcement feeds. A tiered source is
  // one we have now established is NOT an enforcement action, so it carries no
  // claim on that exemption: a BEA data print at MACRO tier takes the ceiling
  // like any other macro item, and a release-calendar entry must not ride an
  // exemption past a cap it should never reach. Untiered sources are untouched.
  // The exemption belongs to ENFORCEMENT and to untiered sources only. The
  // owner's amendment exempted "enforcement actions"; a data print, a policy
  // statement and an appeal docket are established NOT to be those, so none of
  // them keeps a claim on it.
  const exempt =
    CEILING_EXEMPT.has(String(archetype)) && (regNewsTier === undefined || regNewsTier === "ENFORCEMENT");
  const ledgerOnly = regNewsTier === "ADMINISTRATIVE" || regNewsTier === "NON_MARKET";
  return { score, reasons, exempt, ledgerOnly };
}

/** Default floor. Items below this never push; they land in the day's digest.
 *  Tuned against the 48h replay (see docs/verification/2026-08-01-p4-03-salience.md). */
export const DEFAULT_SALIENCE_FLOOR = 45;

/** Default per-day pushes per category before the rest rolls into a digest.
 *  Absent categories fall back to DEFAULT_CATEGORY_CAP. Exempt categories
 *  ignore both. */
export const DEFAULT_CATEGORY_CAPS: Record<string, number> = {
  FILING_8K: 3,
  HALT: 2,
  INSIDER_NOTICE: 2,
  FILING_FORM4: 2,
  OWNERSHIP_STAKE: 2,
  SETTLEMENT_FAILURE: 1,
  DELISTING: 1,
  PRODUCT_RECALL: 2,
  // TIME-CRITICAL, and the same carve-out the FLOOR already gives them.
  //
  // Review found the round-one HIGH was fixed on one suppression mechanism and
  // not its sibling. CATEGORY_BASE raises these four above the floor with the
  // explicit reasoning that otherwise they are "reachable only in a 21:00 ET
  // roll-up, up to 12.5h after an 08:30 ET print, while the committed TTLs give
  // MACRO_PRINT 12h precisely because it is time-critical." Every word of that
  // applies to the cap: they scored 50-70, all under DEFAULT_CAP_BYPASS_SCORE
  // of 80, so the third print of a heavy morning was held to the evening
  // roll-up — arriving after its own TTL had expired.
  //
  // A heavy macro morning is CPI plus jobless claims plus a Fed speaker, and
  // there is no day on which the fourth of those is noise. Set to 4 rather than
  // exempting the category outright: a stuck upstream feed re-emitting the same
  // print should still hit a ceiling, which is what the cap is for.
  MACRO_PRINT: 4,
  FED_PRESS: 4,
  TREASURY_AUCTION: 4,
  RATE_DECISION: 4,
};

export const DEFAULT_CATEGORY_CAP = 2;

/**
 * A score at or above this ignores the daily category cap entirely.
 *
 * The owner's amendment, implemented literally: "if a day produces 30
 * genuinely high-salience items, push them and let the low-salience
 * categories absorb the squeeze via digests. A hard cap that drops a congress
 * PTR because a quiet category already filled the day is the failure mode to
 * avoid."
 *
 * Caps are first-come-first-served within a day, because a streaming pipeline
 * cannot know what the afternoon holds. Without this bypass the 48h replay
 * held five items the owner had actually approved, scoring 60, 70, 75 and 88,
 * purely because weaker items arrived earlier that morning.
 */
export const DEFAULT_CAP_BYPASS_SCORE = 80;

/** Parse "ARCHETYPE:n,ARCHETYPE:n" into caps, merged over the defaults.
 *  Invalid entries are skipped with the defaults intact — a typo must never
 *  silently zero a category (same rule as QUEUE_TTL_OVERRIDES). */
export function parseCategoryCaps(raw: string | undefined): { caps: Record<string, number>; skipped: string[] } {
  const caps: Record<string, number> = { ...DEFAULT_CATEGORY_CAPS };
  const skipped: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const m = /^([A-Z0-9_]+):(\d+)$/.exec(trimmed);
    if (!m) {
      skipped.push(trimmed);
      continue;
    }
    caps[m[1]!] = Number(m[2]);
  }
  return { caps, skipped };
}
