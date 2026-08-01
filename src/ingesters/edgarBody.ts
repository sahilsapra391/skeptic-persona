import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { htmlToText, scrubUrls } from "../lib/html";
import { SCORE_POSTABLE } from "../lib/db";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Capture the 8-K's ACTUAL text into items.raw_text.
//
// WHY: edgar_8k is the highest-volume postable source (293 items measured
// 2026-08-01) and the thinnest that has more to give -- 5.7 payload fields,
// which is a company name and a list of item codes. Generation writes its
// commentary from that.
//
// p4-01 falls back to fetching source_url when raw_text is absent, but for
// this source source_url is the EDGAR INDEX page. Fetching it returns 2,077
// characters of navigation chrome and a Google Tag Manager snippet -- not the
// filing. Verified on a live accession 2026-08-01. So the fallback silently
// grounds every 8-K commentary in boilerplate.
//
// The primary document beside it holds 6,422 characters of real filing text.
// The full-submission .txt holds 42,472, but most of that is SGML headers and
// XBRL, so the primary document is both smaller and cleaner.
//
// Runs as its own low-priority job rather than at ingest: two fetches per
// filing on the ingest path would land on a tick already over its time
// budget, and only postable items are worth the bytes.

export const SOURCE = "edgar_8k_body";

/** Small: two fetches each, and SEC asks for <=10 req/s. */
export const BODY_BATCH = 5;

/**
 * Same ceiling the generation path applies to official hosts. An 8-K in the
 * QUEUEABLE_ITEMS set is routinely an agreement -- merger, credit, employment
 * -- and those run into the hundreds of kilobytes. htmlToText's RAW_BODY_CAP
 * bounds the INPUT at 300k, which is not the same thing: without this the
 * whole document reached raw_text and then the prompt.
 */
export const BODY_TEXT_CAP = 24_000;

/**
 * XBRL and index artifacts that share the .htm extension or sit beside it.
 * Everything here is a by-product of the filing, not the filing.
 */
const NOT_THE_DOCUMENT = /(-index|-index-headers|_htm\.xml|_lab|_cal|_def|_pre)/i;

export interface EdgarFile {
  name: string;
}

/**
 * Pick the filing's primary document from an EDGAR directory listing.
 *
 * The listing's own "type" field is an icon filename (text.gif), not a
 * document type, so it cannot be used. The primary document is the first
 * content .htm: index pages and XBRL siblings are excluded by name.
 */
export function pickPrimaryDoc(files: readonly EdgarFile[]): string | null {
  for (const f of files) {
    const name = f?.name ?? "";
    if (!/\.html?$/i.test(name)) continue;
    if (NOT_THE_DOCUMENT.test(name)) continue;
    return name;
  }
  return null;
}

/** "…/000177739326000057/0001777393-26-000057-index.htm" -> "…/000177739326000057" */
export function edgarDirOf(indexUrl: string): string | null {
  const m = /^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/[^/]+\/[^/]+)\//.exec(indexUrl.trim());
  return m ? (m[1] ?? null) : null;
}

interface PendingRow {
  id: number;
  source_url: string;
}

export async function captureEdgarBodies(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);

  // Score-gated, newest first: a filing the scorer already called log-only
  // is not worth two fetches.
  //
  // Deliberately NOT status-filtered. A stale-at-ingest row (score >= 2,
  // status 'logged') and a digested row can both still be promoted later,
  // and when that happens the body is already here. The earlier comment
  // claimed "only postable items", which the predicate never enforced --
  // fixing the comment rather than the behaviour, because the behaviour is
  // the one we want.
  const pending = await env.DB.prepare(
    `SELECT id, source_url FROM items
      WHERE source = 'edgar_8k' AND raw_text IS NULL AND score >= ?1
      ORDER BY id DESC LIMIT ?2`,
  )
    .bind(SCORE_POSTABLE, BODY_BATCH)
    .all<PendingRow>();

  let captured = 0;
  for (const row of pending.results) {
    if (!budget.take(2)) break; // listing + document

    const dir = edgarDirOf(row.source_url);
    if (!dir) {
      log("warn", "edgar body: unrecognised index url", { id: row.id, url: row.source_url });
      continue;
    }

    try {
      const listing = await politeFetch(`${dir}/index.json`, { userAgent, timeoutMs: 20_000 });
      if (!listing.ok) throw new Error(`listing ${listing.status}`);
      const doc = JSON.parse(listing.body) as { directory?: { item?: EdgarFile[] } };
      const primary = pickPrimaryDoc(doc.directory?.item ?? []);
      if (!primary) {
        log("info", "edgar body: no primary document in listing", { id: row.id });
        continue;
      }

      const url = `${dir}/${primary}`;
      const res = await politeFetch(url, { userAgent, timeoutMs: 25_000 });
      if (!res.ok) throw new Error(`document ${res.status}`);
      // scrubUrls for the same reason sourceText.ts does it: the prompt is
      // URL-free by contract, and a scheme-less .gov domain echoed into a
      // post gets linkified by X while our weighted-length counter scores it
      // at 7 instead of 23. 8-K bodies carry these constantly ("available on
      // the Commission's website at www.sec.gov", IR links in Item 7.01).
      const full = scrubUrls(htmlToText(res.body)).trim();
      const text = full.slice(0, BODY_TEXT_CAP);
      // An empty extraction is not a document. Leaving raw_text NULL keeps it
      // in the queue for a later attempt rather than freezing emptiness in.
      if (text.length === 0) {
        log("info", "edgar body: document produced no text", { id: row.id, url });
        continue;
      }

      await env.DB.prepare(`UPDATE items SET raw_text = ?1, raw_meta = ?2 WHERE id = ?3`)
        .bind(
          text,
          JSON.stringify({
            mode: "full",
            host: "www.sec.gov",
            fetchedAt: iso(now),
            bytes: res.body.length,
            truncated: full.length > BODY_TEXT_CAP,
            // The filename is provenance: an 8-K's first content .htm is
            // usually the filing itself, but it can be an exhibit, and the
            // prompt should be able to tell which document it is reading.
            document: primary,
          }),
          row.id,
        )
        .run();
      captured += 1;
    } catch (e) {
      log("warn", "edgar body capture failed", { id: row.id, error: String(e) });
    }
  }

  if (captured > 0) log("info", "edgar bodies captured", { captured, considered: pending.results.length });
}
