// p6-02 (A2, ruled under B-10.4): ONE resolution chain for cashtags.
//
// Measured on live cards #1200-#1260: 22 of 58 carried a cashtag (38%), split
// almost perfectly along which form carries a symbol. FILING_FORM4 was 18/18,
// because Form 4's ownership XML states `issuerTradingSymbol` outright.
// INSIDER_NOTICE was 0/7 and FILING_8K 0/4, because neither document carries a
// symbol and neither lane looked one up.
//
// TWO CORRECTIONS TO THE PLAN'S DIAGNOSIS, both measured (B-15.6):
//
//   1. A2 said the unresolved lanes "fall through to the 87%-unmapped
//      cusip_map". They do not reference cusip_map at all. Form 144 attempted
//      NO resolution of any kind, and `shared.ts` said so deliberately:
//      "deliberately excluded because it parses no symbol at all". That
//      decision is overturned here, on the record, rather than quietly.
//   2. A2 said to "ingest the SEC's own CIK-to-ticker mapping file". We have
//      ingested it since 2026-07-28 -- `issuers.ts` fetches
//      company_tickers_exchange.json and holds 8,056 rows. Nothing needed
//      building. The gap was only ever that two lanes never asked.
//
// ORDER (B-10.4): filing-supplied symbol, then the CIK map, then cusip_map,
// then the issuer name as filed. Never guess, never infer a symbol from a
// name, and record WHERE the answer came from so a card can be audited.

import type { Env } from "../env";
import { isNonCommonSymbol, lookupIssuer, type Issuer } from "../ingesters/issuers";

/** Where a cashtag came from. Stored on the payload for audit (A2). */
export type SymbolSource =
  | "filing" // the document stated the symbol itself (Form 4)
  | "cik_map" // SEC's own CIK -> ticker file, via the issuers table
  | "cik_map_class" // same, disambiguated by the filing's own class title
  | "cusip_map" // openFIGI, for lanes keyed on CUSIP
  | "issuer_name" // nothing resolved; the name as filed is the honest label
  | "none";

export interface ResolvedSymbol {
  /** The cashtag WITHOUT its `$`, or null when nothing resolved. */
  ticker: string | null;
  /** What a template should print: the cashtag, or the issuer name as filed. */
  label: string;
  source: SymbolSource;
  /** Set when the CIK offered several share classes and we had to choose. */
  ambiguity?: string;
}

export interface ResolveInput {
  /** A symbol the document itself stated. Outranks everything. */
  filingSymbol?: string | null;
  cik?: string | number | null;
  /** The filing's own class title, e.g. Form 144 `securitiesClassTitle`. */
  securitiesClass?: string | null;
  /** The issuer name as filed. Always the fallback, never absent. */
  issuerName: string;
  /** An already-fetched issuer row. The 8-K lane loads one for the float gate
   *  on every filing, so passing it here resolves the symbol for free rather
   *  than repeating a primary-key read on the hottest path in the pipeline. */
  issuer?: Issuer | null;
}

/** `Class B Common Stock` -> `B`. Only a single letter counts; anything else
 *  is not a class designation we can match against a ticker suffix. */
export function classLetter(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = /\bclass\s+([A-Za-z])\b/i.exec(title);
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Resolve one issuer to the label a card should print.
 *
 * Never throws and never returns an empty label: the issuer name as filed is
 * always available and is always honest.
 */
export async function resolveSymbol(env: Env, input: ResolveInput): Promise<ResolvedSymbol> {
  const name = input.issuerName.trim();
  const asName = (source: SymbolSource): ResolvedSymbol => ({ ticker: null, label: name, source });

  // 1. The document's own symbol. A filing that states its ticker is the
  //    primary source for it, and nothing we hold outranks that.
  const filed = (input.filingSymbol ?? "").trim().toUpperCase();
  if (filed !== "" && !isNonCommonSymbol(filed)) {
    return { ticker: filed, label: `$${filed}`, source: "filing" };
  }

  // 2. SEC's CIK map. A primary-key hit, one row, already in the issuers table.
  const row =
    input.issuer !== undefined
      ? input.issuer
      : input.cik === null || input.cik === undefined
        ? null
        : await lookupIssuer(env, input.cik);
  if (row && row.ticker !== "") {
    // A wrong ticker is worse than none, and the selection at ingest can only
    // be as good as the file. This is the last line of defence: a preferred
    // series, warrant, unit or right never becomes a cashtag, whatever is
    // stored (B-15.4).
    if (isNonCommonSymbol(row.ticker)) return asName("issuer_name");

    // B-10.4 tier 2: when the CIK carried several share classes, prefer the
    // one the FILING itself names. `ticker_alts` holds the alternatives, and
    // it is populated only for those ~20 issuers.
    const wanted = classLetter(input.securitiesClass);
    const alts = (row.tickerAlts ?? "").split(",").filter((t) => t !== "");
    if (wanted && alts.length > 0) {
      const match = [row.ticker, ...alts].find((t) => t.toUpperCase().endsWith(`-${wanted}`));
      if (match && match !== row.ticker) {
        return { ticker: match, label: `$${match}`, source: "cik_map_class" };
      }
    }
    return {
      ticker: row.ticker,
      label: `$${row.ticker}`,
      source: "cik_map",
      ...(alts.length > 0 ? { ambiguity: [row.ticker, ...alts].join(",") } : {}),
    };
  }

  // 3. The issuer name as filed. Honest, licensed by the record, and the thing
  //    the desk printed before any of this existed.
  return asName("issuer_name");
}
