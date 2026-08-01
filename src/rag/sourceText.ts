import type { Env } from "../env";
import { buildUserAgent, politeFetch } from "../lib/http";
import { htmlToText, scrubUrls } from "../lib/html";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// SOURCE DOCUMENT text for the generation prompt (p4-01, doc Part A1).
//
// Two writers fill items.raw_text: ingesters that already hold the bytes
// (press RSS descriptions, at insert), and THIS module's one-time conditional
// fetch at generation for items without it. The result is cached on the item
// row, so a document is fetched at most once ever, through the same polite
// stack every ingester uses (declared UA, timeout; the politeness doctrine
// is the P1 one, not a new client).
//
// Copyright rule (owner doc, Part A1): government/official documents go in
// whole (capped); anything not on the official-host list gets headline-scale
// excerpting. The default is the conservative mode.

/** Hosts the Worker cannot reach (verified egress blocks; see docs/verification). */
/**
 * Sources with a DEDICATED capture job, which the generation fallback must
 * not race.
 *
 * For edgar_8k, source_url is the EDGAR index page: 2,077 characters of
 * navigation chrome that licenses 78 numbers through groundingFacts -- CIK,
 * accession fragments, item codes -- and passes both the prose and anchor
 * gates, because it IS prose and it DOES name the company. It is not the
 * wrong document; it is the right record's wrong representation, which no
 * content test can detect.
 *
 * The race is real and tight: an 8-K approved minutes after ingest reaches
 * generation before edgar_8k_body has run, the fallback caches the chrome,
 * and the capture job then skips that row forever because raw_text is no
 * longer NULL. Skipping the fallback for this source means the item grounds
 * on payload alone until the capture lands, which is strictly better than
 * grounding on chrome and permanently so.
 */
export function hasDedicatedCapture(source: string): boolean {
  return DEDICATED_CAPTURE_SOURCES.includes(source);
}

const DEDICATED_CAPTURE_SOURCES = ["edgar_8k"];

const EGRESS_BLOCKED_HOSTS = [
  "www.cftc.gov",
  "efdsearch.senate.gov",
  "www.treasurydirect.gov",
  "api.fiscaldata.treasury.gov",
  "www.nseindia.com",
];

/** Official-source hosts whose documents may enter the prompt in full. */
const FULL_TEXT_HOST_SUFFIXES = [
  ".sec.gov", "sec.gov",
  ".federalregister.gov", "federalregister.gov",
  ".fda.gov", "fda.gov",
  ".bls.gov", "bls.gov",
  ".noaa.gov", "noaa.gov",
  ".house.gov", "house.gov",
  ".senate.gov", "senate.gov",
  ".federalreserve.gov", "federalreserve.gov",
  ".treasury.gov", "treasury.gov",
  ".cftc.gov", "cftc.gov",
  ".ftc.gov", "ftc.gov",
  ".fca.org.uk", "fca.org.uk",
  "ec.europa.eu", ".ecb.europa.eu", "ecb.europa.eu",
  ".bankofengland.co.uk", "bankofengland.co.uk",
  ".boj.or.jp", "boj.or.jp",
  ".snb.ch", "snb.ch",
  ".norges-bank.no", "norges-bank.no",
  ".riksbank.se", "riksbank.se",
  ".rba.gov.au", "rba.gov.au",
  ".boi.org.il", "boi.org.il",
  ".bcb.gov.br", "bcb.gov.br",
  ".resbank.co.za", "resbank.co.za",
  ".bankofcanada.ca", "bankofcanada.ca",
];

/** ~6k tokens of full text; headline-scale for everything else. */
const FULL_TEXT_CAP = 24_000;
const EXCERPT_CAP = 1_200;

export interface SourceText {
  text: string;
  /** "ingest_rss" | "full" | "excerpt" */
  mode: string;
  host: string;
  fetchedAt: string;
  cached: boolean;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Callers gate their fetch budget on this: a blocked host must not cost a
 *  budget token for a fetch that will never happen (review finding). */
export function isBlockedGroundingHost(url: string): boolean {
  const h = hostOf(url);
  return h !== null && EGRESS_BLOCKED_HOSTS.includes(h);
}

function isFullTextHost(host: string): boolean {
  return FULL_TEXT_HOST_SUFFIXES.some((s) => (s.startsWith(".") ? host.endsWith(s) : host === s));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ItemRow {
  id: number;
  source: string;
  source_url: string;
  raw_text: string | null;
  raw_meta: string | null;
}

/**
 * Return the source document's text for an item, fetching and caching it on
 * first use. Never throws; a miss (blocked host, fetch failure, unparseable
 * body) returns null and generation proceeds on payload + lake context.
 */
export async function fetchSourceText(env: Env, item: ItemRow, now: Date = new Date()): Promise<SourceText | null> {
  if (item.raw_text) {
    let meta: Record<string, unknown> = {};
    try {
      meta = item.raw_meta ? (JSON.parse(item.raw_meta) as Record<string, unknown>) : {};
    } catch {
      /* provenance is best-effort on legacy rows */
    }
    return {
      text: item.raw_text,
      mode: typeof meta["mode"] === "string" ? (meta["mode"] as string) : "full",
      host: typeof meta["host"] === "string" ? (meta["host"] as string) : (hostOf(item.source_url) ?? "unknown"),
      fetchedAt: typeof meta["fetchedAt"] === "string" ? (meta["fetchedAt"] as string) : "unknown",
      cached: true,
    };
  }

  // A source with its own capture job must not be raced by this fallback.
  // Cached text above is still served; only the FETCH is skipped, so the
  // item grounds on payload alone until the capture lands rather than
  // permanently caching whatever source_url happens to return.
  if (DEDICATED_CAPTURE_SOURCES.includes(item.source)) {
    log("info", "source text deferred to dedicated capture", { itemId: item.id, source: item.source });
    return null;
  }

  const host = hostOf(item.source_url);
  if (!host) return null;
  if (EGRESS_BLOCKED_HOSTS.includes(host)) {
    log("info", "source text skipped: egress-blocked host", { itemId: item.id, host });
    return null;
  }

  let body: string;
  try {
    const res = await politeFetch(item.source_url, {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
    });
    if (!res.ok) {
      log("warn", "source text fetch failed", { itemId: item.id, host, status: res.status });
      return null;
    }
    body = res.body;
  } catch (e) {
    log("warn", "source text fetch threw", { itemId: item.id, host, error: String(e) });
    return null;
  }

  // URL scrub: the generation prompt is URL-free by contract, and grounding
  // text flows straight into it.
  const stripped = scrubUrls(htmlToText(body));
  if (stripped.length === 0) return null;
  const mode = isFullTextHost(host) ? "full" : "excerpt";
  const cap = mode === "full" ? FULL_TEXT_CAP : EXCERPT_CAP;
  const text = stripped.slice(0, cap);
  const fetchedAt = iso(now);
  const meta = {
    host,
    fetchedAt,
    sha256: await sha256Hex(stripped),
    bytes: body.length,
    mode,
    truncated: stripped.length > cap,
  };

  // Cache write-once; a lost write costs one refetch, nothing else.
  await env.DB.prepare(`UPDATE items SET raw_text = ?1, raw_meta = ?2 WHERE id = ?3 AND raw_text IS NULL`)
    .bind(text, JSON.stringify(meta), item.id)
    .run()
    .catch((e: unknown) => log("warn", "raw_text cache write failed", { itemId: item.id, error: String(e) }));

  return { text, mode, host, fetchedAt, cached: false };
}
