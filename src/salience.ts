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
  FED_PRESS: 40,
  TREASURY_AUCTION: 38,
  // Measured weakest.
  MACRO_PRINT: 35,
  RATE_DECISION: 25,
};

const DEFAULT_BASE = 40;

/** Categories the owner exempted from the daily ceiling (amendment 2026-08-01):
 *  "a hard cap that drops a congress PTR because a quiet category already
 *  filled the day is the failure mode to avoid." */
export const CEILING_EXEMPT: ReadonlySet<string> = new Set(["CONGRESS_PTR", "REGULATORY_NEWS", "POLICY_ACTION"]);

export interface Salience {
  /** 0-100. Higher asks louder. */
  score: number;
  /** Machine-readable reasons, for the replay report and the weekly digest. */
  reasons: string[];
  /** True when this category ignores the daily ceiling. */
  exempt: boolean;
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
    default:
      break;
  }

  const score = Math.max(0, Math.min(100, base + magnitude));
  return { score, reasons, exempt: CEILING_EXEMPT.has(String(archetype)) };
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
