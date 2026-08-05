import type { Env } from "../env";
import { politeFetch } from "./http";
import { iso } from "./time";
import { log } from "./log";

// 13F-02: CUSIP -> ticker via openFIGI, cached in D1, fail-open to issuer
// name. Endpoint live-verified 2026-08-04 on 20 real CUSIPs from a real
// current-window filing (docs/verification/2026-08-04-13f-02.md): 19 mapped,
// 1 legitimate miss (a CINS), two batches of 10 jobs, no API key.
const FIGI_URL = "https://api.openfigi.com/v3/mapping";

/** Jobs per request. 10 verified working WITHOUT a key (two live batches);
 *  kept at 10 with a key too — 84 distinct CUSIPs in a real 112-row filing
 *  means ~9 requests per new filing, which one request per tick absorbs in
 *  minutes. A constant that works in both auth states beats one that has to
 *  know which state it is in. */
export const FIGI_BATCH = 10;

export interface FigiResult {
  cusip: string;
  ticker: string | null;
  name: string | null;
}

/**
 * Pick the US composite listing, or nothing.
 *
 * Measured live (fixtures in test/fixtures/openfigi-*.json.fixture): most US
 * issuers return their US composite FIRST, but not all —
 *
 *   - FIRST HORIZON (320517105): data[0..4] are FT2 on German venues; the US
 *     listing (FHN) sits at position 6. data[0] would put a GERMAN ticker on
 *     the account.
 *   - EXXON (30231G102): ELEVEN entries, ZERO with exchCode US — Kazakh and
 *     Uzbek listings only (no key). Any pick here is a wrong ticker.
 *
 * So: exchCode === "US" wins; anything else is NO ticker, and the caller
 * falls open to the issuer name the filing itself states. A foreign ticker is
 * worse than no ticker — the issuer name is licensed by the record, XOM_KZ is
 * not.
 */
export function selectUsListing(
  data: ReadonlyArray<{ ticker?: string | null; name?: string | null; exchCode?: string | null }> | undefined,
): { ticker: string | null; name: string | null } {
  if (!data || data.length === 0) return { ticker: null, name: null };
  const us = data.find((d) => d.exchCode === "US");
  if (us) return { ticker: us.ticker ?? null, name: us.name ?? null };
  // Keep a name if the API offered one (better display than a raw CUSIP in
  // logs), but never a non-US ticker.
  return { ticker: null, name: data[0]?.name ?? null };
}

/**
 * Resolve up to FIGI_BATCH unmapped CUSIPs into cusip_map. One POST per call;
 * the caller decides cadence (one call per tick from the 13F drain).
 *
 * Misses are cached too (ticker NULL, source 'openfigi_nodata') so a CUSIP
 * openFIGI cannot map is asked once, not every tick. A transport failure
 * caches NOTHING — a network error is not evidence about the CUSIP.
 */
export async function resolveCusipBatch(env: Env, cusips: readonly string[], now: Date = new Date()): Promise<number> {
  const batch = cusips.slice(0, FIGI_BATCH);
  if (batch.length === 0) return 0;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.OPENFIGI_API_KEY) headers["X-OPENFIGI-APIKEY"] = env.OPENFIGI_API_KEY;

  const res = await politeFetch(FIGI_URL, {
    userAgent: "SkepticWire/1.0 (admin@spechawk.ai)",
    method: "POST",
    postBody: JSON.stringify(batch.map((c) => ({ idType: "ID_CUSIP", idValue: c }))),
    headers,
    timeoutMs: 20_000,
  });
  if (!res.ok) {
    log("warn", "openFIGI mapping failed; nothing cached", { status: res.status, batch: batch.length });
    return 0;
  }

  let parsed: Array<{ data?: Array<{ ticker?: string | null; name?: string | null; exchCode?: string | null }> }>;
  try {
    parsed = JSON.parse(res.body) as typeof parsed;
  } catch {
    log("warn", "openFIGI returned non-JSON; nothing cached", { bytes: res.body.length });
    return 0;
  }
  if (!Array.isArray(parsed) || parsed.length !== batch.length) {
    // A response that does not line up 1:1 with the jobs must not be zipped —
    // misaligned rows would cache the WRONG ticker against a CUSIP, which is
    // a fabrication vector, not a glitch.
    log("warn", "openFIGI response misaligned with jobs; nothing cached", { jobs: batch.length, results: Array.isArray(parsed) ? parsed.length : -1 });
    return 0;
  }

  const stmts = batch.map((cusip, i) => {
    const pick = selectUsListing(parsed[i]?.data);
    return env.DB.prepare(
      `INSERT OR REPLACE INTO cusip_map (cusip, ticker, name, source, resolved_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(cusip, pick.ticker, pick.name, pick.ticker ? "openfigi" : "openfigi_nodata", iso(now));
  });
  await env.DB.batch(stmts);
  return batch.length;
}

/** Display string for a position: ticker when the US listing is known, else
 *  the issuer name the filing itself states. Fail-open by design — a post
 *  can always say "EXXON MOBIL CORP"; it must never say "XOM_KZ". */
export function displayFor(ticker: string | null | undefined, issuer: string): string {
  return ticker && ticker.length > 0 ? `$${ticker}` : issuer;
}
