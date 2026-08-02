import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { unzipEntry } from "../lib/zip";
import { getSourceState, insertItem, putSourceState, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { iso } from "../lib/time";
import { log } from "../lib/log";
import { enqueueForApproval } from "../pipeline/enqueue";
import { bandSpan, bandWidth, isFreshDateOnly, lagDays, mdyToIso } from "./shared";
import { scrubUrls } from "../lib/html";

// House Clerk PTR discovery (live-verified 2026-07-26; ZIP fixture captured
// 2026-07-27T04:52Z). The bulk index rebuilds ~once per weekday ~13:00 UTC;
// rows carry NO document URL and NO time-of-day. E-filed PTR PDFs
// (8-digit 200xxxxx DocIDs) are text-layer but RC4-encrypted — transaction
// extraction is the daily GitHub Actions job's work (build plan's
// heavy-parsing lane), NOT this Worker's. This ingester keeps the lake
// current at discovery level: member, filing date, document link.

export const SOURCE = "house_ptr";

/**
 * Ceiling for a filing body stored as grounding text. Matches the generation
 * path's official-host cap so a PTR body cannot crowd a prompt that other
 * sources are already sized against.
 */
export const HOUSE_RAW_TEXT_CAP = 24_000;

export function houseZipUrl(year: number): string {
  return `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
}

export interface HouseTxn {
  /** Owner code as filed: SP spouse, DC dependent child, JT joint, "" filer. */
  owner: string;
  assetName: string;
  ticker: string | null;
  assetType: string | null;
  /** As filed: P purchase, S sale, E exchange. */
  type: string;
  transactionDate: string; // MM/DD/YYYY as filed
  notificationDate: string;
  /** VERBATIM band, never a midpoint. */
  amount: string;
}

// The transaction line is the anchor. VERIFIED SHAPE (two live filings,
// 2026-07-28): the two dates arrive CONCATENATED with no separator and the
// amount band follows immediately —
//   "P 06/18/202606/30/2026$1,001 - $15,000"
// NOT anchored to start of line. VERIFIED NECESSARY: when an asset name is
// short enough not to wrap, the name and the transaction share ONE line —
//   "Home Depot, Inc. (HD) [ST] P 06/17/202606/30/2026$1,001 - $15,000"
// A start-anchored pattern silently dropped that entire transaction, which is
// fabrication by omission: the post would be complete and the trade absent.
// The type token is NOT always a bare letter: partial sales file as
// "S (partial)". VERIFIED on live filing 20034736 (2026-07-28), where the
// bare-letter pattern parsed 0 of 1 transactions.
//
// The code is also not reliably preceded by whitespace. The extractor glues
// it to whatever ends the asset cell, and BOTH shapes occur on live filings
// (found 2026-08-01 by the completeness gate refusing five real filings):
//   "Procter & Gamble Company (PG) [ST]S 01/29/202601/30/2026$1,001 - $15,000"
//   "JP Morgan Chase & Co. CommonP 01/16/202601/30/2026$1,001 - $15,000"
// so a bracket or a lowercase letter is a valid boundary too. These are
// LOOKBEHINDS, not consumed characters: the asset name is everything before
// m.index, and eating the "]" would strip the [ST] the tail parser needs.
//
// An UPPERCASE letter is deliberately NOT a boundary. "…(XOM)P" would be
// indistinguishable from a ticker losing its last character.
//
// Whitespace between the dates and the amount is optional for the same
// reason: "P 12/18/202512/19/2025 $100,001 - $250,000" (filing 20033718).
const TXN_LINE_RE =
  /(?:^|(?<=[\s\]a-z]))([A-Z](?:\s*\([A-Za-z]+\))?)\s+(\d{2}\/\d{2}\/\d{4})\s*(\d{2}\/\d{2}\/\d{4})\s*(\$[\d,]+\s*-\s*\$[\d,]+)\s*$/;
/**
 * Asset lines end with "(TICKER) [TYPE]". Both parts are genuinely optional:
 * non-traded assets (funds, notes) carry a bracket type and NO ticker, e.g.
 * "Opportunity Fund II (GLAS Funds, LP) [HN]" — the parenthesis there is part
 * of the fund's NAME, not a ticker. Requiring the ticker left "[HN" stranded
 * in the asset name (live filing 20035075, 2026-07-28).
 */
const ASSET_TAIL_RE = /\(([A-Z.\-]{1,8})\)\s*(?:\[([A-Z]{2,3})\])?\s*$/;
/** Bracket-only tail, for assets with no ticker at all. */
const ASSET_TYPE_ONLY_RE = /\[([A-Z]{2,3})\]\s*$/;
const OWNER_RE = /^(SP|DC|JT)\s+/;

/**
 * Count transaction MARKERS with a deliberately loose pattern: the
 * concatenated date pair followed by a dollar sign, anywhere in the text.
 *
 * This exists to check the strict parser against something other than
 * itself. The strict pattern once matched 15 rows in a filing that contained
 * 16, silently dropping a Home Depot purchase, and nothing downstream could
 * tell — the post would have been complete with a trade simply absent.
 * A completeness check has to count against a signal the DOCUMENT emits,
 * not against what the parser managed to read.
 */
export function countTxnMarkers(raw: string): number {
  // Whitespace-tolerant ON PURPOSE. The strict pattern requires the dates and
  // the amount to be glued together; if an extraction ever separates them,
  // a count that shared that assumption would be blind in exactly the same
  // place as the parser and the equality check would pass on a short read.
  return (raw.replace(/\u0000/g, "").match(/\d{2}\/\d{2}\/\d{4}\s*\d{2}\/\d{2}\/\d{4}\s*\$/g) ?? []).length;
}

/**
 * Rejoin an amount band that the PDF wrapped across two lines.
 *
 * VERIFIED on live filing 20034736 (2026-07-28):
 *   "S (partial) 07/21/202607/22/2026$15,001 -"
 *   "$50,000"
 * The transaction pattern requires a complete band at end of line, so the
 * wrap dropped the whole trade. The marker count still saw it, which is how
 * this was found rather than shipped.
 *
 * Only a DANGLING separator absorbs the next line, and only the leading
 * amount token moves; anything else on that line is left where it was.
 */
function stitchWrappedAmounts(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    const next = lines[i + 1];
    if (/\$[\d,]+\s*-\s*$/.test(line) && next !== undefined) {
      const m = /^(\$[\d,]+)(.*)$/.exec(next.trim());
      if (m) {
        line = `${line} ${m[1]}`;
        const rest = (m[2] ?? "").trim();
        out.push(line);
        // The remainder keeps its own line so the backward name walk and the
        // stop-labels below still see the document's real structure.
        lines[i + 1] = rest;
        if (rest === "") i += 1;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Parse the transaction table out of a House PTR PDF's extracted text.
 *
 * The PDF is RC4-encrypted with an EMPTY owner password and carries a real
 * text layer — verified on live filings 2026-07-28. Decryption and text
 * extraction happen in the GitHub Actions courier (a Worker has no PDF
 * library and zero runtime deps are allowed); the text lands here, so parsing
 * lives with every other parser and stays testable in this repo.
 *
 * Header text arrives peppered with NULL bytes from a font-encoding quirk
 * ("P\x00\x00\x00 T\x00\x00\x00 R" is "PERIODIC TRANSACTION REPORT"), but
 * the DATA lines are clean. Nulls are stripped before anything else.
 */
export function parseHousePtrText(raw: string): HouseTxn[] {
  const lines = stitchWrappedAmounts(raw.replace(/\u0000/g, "").split("\n").map((l) => l.trim()));
  const out: HouseTxn[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    const m = TXN_LINE_RE.exec(current);
    if (!m) continue;

    const nameParts: string[] = [];
    // Anything before the match on THIS line is the asset name (the
    // short-name case above). Only when the line is transaction-only do we
    // walk backward for a wrapped name.
    const inlineName = current.slice(0, m.index).trim();
    if (inlineName !== "") {
      // A LOWERCASE boundary means the asset cell was cut by a page break,
      // not glued. Every intact House cell ends in "[TYPE]" or a ")", so a
      // code sitting directly after a lowercase letter can only happen when
      // the rest of the cell is on the next page:
      //
      //   JP Morgan Chase & Co. CommonP 01/16/202601/30/2026$1,001 - $15,000
      //                        ^ "Stock (JPM) [ST]" is overleaf
      //
      // Accepting it parses the row with a TRUNCATED name and a null ticker,
      // which tradeClause then prints as the asset. Worse, it makes
      // countTxnMarkers agree with the parser, so the completeness gate
      // reports COMPLETE and the filing is promoted. That destroys the only
      // detector we have for page-break truncation -- the count is satisfied
      // while the CONTENT is short, which is the one shape a marker count
      // cannot see.
      //
      // So: skip the row and let the gate refuse the filing, exactly as it
      // did before the lowercase boundary was added.
      const cell = inlineName.replace(/\s+$/, "");
      if (/[a-z]$/.test(cell)) continue;
      nameParts.push(inlineName);
    } else {
      // Walk BACKWARD: a wrapped asset name spans one or two lines above.
      // Stop at the previous entry's labels so a multi-transaction filing
      // cannot bleed one asset into the next.
      // Cap of 4, not 2: the House asset column wraps to three lines on live
      // filing 20035075 and a 2-line cap silently dropped the sponsor
      // ("Riverside Acceleration Capital"), renaming the asset in post copy.
      // The stop-labels below, not the count, are what actually bound this.
      for (let j = i - 1; j >= 0 && nameParts.length < 4; j--) {
        const line = lines[j] ?? "";
        if (line === "" || TXN_LINE_RE.test(line)) break;
        // D: (description) and L: (location) are entry FOOTERS. Widening the
        // walk without them would absorb the previous entry's notes and inject
        // a number from a different field entirely into an asset name.
        if (/^(F\s*S\s*:|S\s*O\s*:|D\s*:|L\s*:|\$200\?|Gains)/.test(line)) break;
        nameParts.unshift(line);
      }
    }
    if (nameParts.length === 0) continue;

    let assetName = nameParts.join(" ").replace(/\s+/g, " ").trim();
    const ownerMatch = OWNER_RE.exec(assetName);
    const owner = ownerMatch?.[1] ?? "";
    if (ownerMatch) assetName = assetName.slice(ownerMatch[0].length).trim();

    const tail = ASSET_TAIL_RE.exec(assetName);
    let ticker = tail?.[1] ?? null;
    let assetType = tail?.[2] ?? null;
    if (tail) {
      assetName = assetName.slice(0, tail.index).trim();
    } else {
      const typeOnly = ASSET_TYPE_ONLY_RE.exec(assetName);
      if (typeOnly) {
        assetType = typeOnly[1] ?? null;
        ticker = null;
        assetName = assetName.slice(0, typeOnly.index).trim();
      }
    }

    out.push({
      owner,
      assetName,
      ticker,
      assetType,
      type: (m[1] ?? "").replace(/\s+/g, " ").trim(),
      transactionDate: m[2] ?? "",
      notificationDate: m[3] ?? "",
      amount: (m[4] ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

export function housePdfUrl(year: string, docId: string): string {
  return `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

export interface HousePtrRow {
  member: string; // "First Last Suffix" as filed (honorific prefix dropped)
  stateDst: string;
  year: string;
  filedDate: string; // M/D/YYYY as filed (no leading zeros, no time)
  docId: string;
  efiled: boolean; // 8-digit 200xxxxx family (text-layer PDFs)
}

export interface HouseIndex {
  rows: HousePtrRow[]; // PTR (type P) rows only
  totalDataLines: number; // ALL filing rows — distinguishes sparsity from drift
}

/** Tab-delimited with header; CRLF line endings (verified fixture). */
export function parseHouseIndex(txt: string): HouseIndex {
  const lines = txt.split("\n");
  const rows: HousePtrRow[] = [];
  let totalDataLines = 0;
  for (const line of lines.slice(1)) {
    const cols = line.replace(/\r$/, "").split("\t");
    if (cols.length < 9) continue;
    totalDataLines += 1;
    const [, last, first, suffix, filingType, stateDst, year, filedDate, docId] = cols;
    if (filingType !== "P") continue; // only PTRs; C/X/W/D/A/T/H are other report types
    rows.push({
      member: [first, last, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
      stateDst: stateDst ?? "",
      year: year ?? "",
      filedDate: filedDate ?? "",
      docId: docId ?? "",
      efiled: /^20\d{6}$/.test(docId ?? ""),
    });
  }
  return { rows, totalDataLines };
}

/** M/D/YYYY (date-only, as the Clerk serves it) -> ISO at UTC midnight. */
export function houseDateToIso(mdY: string): string {
  return mdyToIso(mdY);
}

async function ingestRows(env: Env, rows: HousePtrRow[], now: Date): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    if (!row.docId) continue;
    const result = await insertItem(
      env.DB,
      {
        source: SOURCE,
        externalId: row.docId,
        category: "congress",
        eventAt: houseDateToIso(row.filedDate) || null,
        sourceUrl: housePdfUrl(row.year, row.docId),
        payload: {
          member: row.member,
          stateDst: row.stateDst,
          filedDate: row.filedDate,
          efiled: row.efiled,
          // Transactions arrive via the Actions daily job (P2): e-filed PDFs
          // are RC4-encrypted text-layer; 7-digit DocIDs likely scans.
          transactions: null,
        },
        score: SCORE_LOG_ONLY,
        status: "logged",
      },
      now,
    );
    if (result.outcome === "inserted") inserted += 1;
  }
  return inserted;
}

/**
 * Transaction codes as the House form defines them. CLOSED map: an
 * unrecognised code renders as itself rather than being guessed at, because
 * calling a sale a purchase is the worst error this file could make.
 */
const TXN_TYPE: Readonly<Record<string, string>> = {
  P: "Purchase",
  S: "Sale",
  E: "Exchange",
};

function txnTypeLabel(code: string): string {
  // "S (partial)" -> "Sale (partial)". An unrecognised code renders verbatim
  // rather than being guessed at.
  const m = /^([A-Za-z]+)\s*(\(.*\))?$/.exec(code.trim());
  if (!m) return code;
  const base = TXN_TYPE[m[1]!.toUpperCase()] ?? m[1]!;
  return m[2] ? `${base} ${m[2]}` : base;
}

/** Owner codes as filed. Absent prefix = the filer themselves. */
const OWNER_LABEL: Readonly<Record<string, string>> = {
  SP: "spouse",
  DC: "dependent child",
  JT: "joint",
};

function tradeClause(t: HouseTxn): string {
  const what = t.ticker ?? (t.assetName.length > 40 ? `${t.assetName.slice(0, 40)}…` : t.assetName);
  const owner = OWNER_LABEL[t.owner] ? ` [${OWNER_LABEL[t.owner]}]` : "";
  return `${txnTypeLabel(t.type)} ${t.amount}, ${what}${owner} (${t.transactionDate})`;
}

/** Trade list for the whoWhen skeleton, always carrying its elision marker. */
export function houseTradeLine(txns: HouseTxn[]): string {
  const shown = txns.slice(0, 3).map(tradeClause).join("; ");
  return txns.length > 3 ? `${shown} +${txns.length - 3} more` : shown;
}

/**
 * Tier A draft. Mirrors draftSenatePtr deliberately: the two chambers file
 * the same disclosure under the same statute, and a reader should not be able
 * to tell which parser produced the line.
 */
export function draftHousePtr(member: string, txns: HouseTxn[], filedIso: string, filedDate: string): string {
  const shown = txns.slice(0, 3).map(tradeClause);
  const more = txns.length > 3 ? ` +${txns.length - 3} more` : "";
  const lags = txns.map((t) => lagDays(filedIso, t.transactionDate)).filter((d): d is number => d !== null);
  const lag = lags.length > 0 ? `, disclosed ${Math.min(...lags)} days after the latest trade` : "";
  return `House PTR: ${member}. ${shown.join("; ")}${more}. Filed ${filedDate}${lag}`;
}

/** Outcome of merging courier-extracted PDF text into a logged House item. */
export type HouseTextOutcome =
  | { status: "queued" | "logged"; docId: string; parsed: number }
  | { status: "unknown_doc" | "no_transactions" | "incomplete"; docId: string; parsed: number; expected?: number };

/**
 * Merge the text of ONE extracted House PTR PDF into its already-logged item.
 *
 * The item exists (the ZIP index created it); this fills in the transactions
 * the index never carried, and promotes it to the approval queue.
 */
export async function applyHousePtrText(
  env: Env,
  docId: string,
  text: string,
  now: Date,
): Promise<HouseTextOutcome> {
  const row = await env.DB.prepare(
    `SELECT id, payload, source_url FROM items WHERE dedup_key = ?1`,
  )
    .bind(`${SOURCE}:${docId}`)
    .first<{ id: number; payload: string; source_url: string }>();
  // No row means the courier is working from a doc list this Worker never
  // indexed. Reported, never invented: an item created here would have no
  // member name, no filing date, and nothing to attribute.
  if (!row) return { status: "unknown_doc", docId, parsed: 0 };

  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const txns = parseHousePtrText(text);
  if (txns.length === 0) return { status: "no_transactions", docId, parsed: 0 };

  // COMPLETENESS GATE. The loose marker count is the only signal independent
  // of the strict parser, and a partial trade list is worse than none: the
  // post reads as the member's full activity while a trade is simply gone.
  const expected = countTxnMarkers(text);
  if (expected !== txns.length) {
    log("error", "house_ptr incomplete extraction; refusing to queue", {
      docId,
      parsed: txns.length,
      expected,
    });
    return { status: "incomplete", docId, parsed: txns.length, expected };
  }

  const filedDate = typeof payload.filedDate === "string" ? payload.filedDate : "";
  const filedIso = houseDateToIso(filedDate);
  const member = typeof payload.member === "string" ? payload.member : "";
  if (!member || !filedIso) return { status: "no_transactions", docId, parsed: txns.length };

  const dated = txns.filter((t) => lagDays(filedIso, t.transactionDate) !== null);
  const newest = dated
    .slice()
    .sort((a, b) => (lagDays(filedIso, a.transactionDate)! < lagDays(filedIso, b.transactionDate)! ? -1 : 1))[0];
  const minLag = newest ? lagDays(filedIso, newest.transactionDate) : null;
  const fresh = isFreshDateOnly(filedIso, now);

  const merged = {
    ...payload,
    transactions: txns,
    // Selects the House citation from the archetype's closed map. Without it
    // the renderer fails closed rather than citing the Senate.
    chamber: "house",
    factLine: draftHousePtr(member, txns, filedIso, filedDate),
    who: member,
    // See tradeLineOf in senatePtr: the marker is load-bearing, not cosmetic.
    tradeLine: houseTradeLine(txns),
    tradeDate: newest?.transactionDate ?? null,
    amountBand: newest?.amount ?? null,
    singleTxn: txns.length === 1,
    lagDays: minLag,
    bandSpanRatio: bandSpan(newest?.amount ?? ""),
    bandWidthUsd: bandWidth(newest?.amount ?? ""),
  };

  // A filing whose PDF arrives days after the index row still belongs in the
  // lake; it just does not interrupt anyone.
  const status = fresh ? "new" : "logged";
  // CAPTURE THE FILING'S OWN TEXT AS GROUNDING.
  //
  // The courier already extracted this to parse transactions out of it, and
  // until now it was discarded the moment parsing finished. Storing it costs
  // NO extra fetch -- the bytes are already in this request -- and CONGRESS_PTR
  // is both the signature archetype and the deepest-exemplared one, so it is
  // the highest-value grounding text available anywhere in the pipeline.
  //
  // Trimmed to the same 24k ceiling the generation path uses for official
  // hosts, and NULs are stripped: House PDFs carry them from a font-encoding
  // quirk, and a NUL reaching a prompt is invisible junk at best.
  // scrubUrls, for the same reason every other raw_text writer does it
  // (edgarBody, sourceText, regulatoryPress): the generation prompt is
  // URL-free by contract. Not hypothetical here -- EVERY House PTR carries
  // the asset-type footnote https://fd.house.gov/reference/... beneath its
  // transaction table, all seven fixtures included. Without this the SOURCE
  // DOCUMENT block would hold a URL in the same prompt that says "No URLs or
  // links of any kind". Nothing bad ships, since urlCheck is fail-closed at
  // publish, but every variant echoing it is rejected -- which burns the
  // retries and pushes CONGRESS_PTR, the deepest-exemplared archetype,
  // toward the template fallback this capture exists to avoid.
  const cleaned = scrubUrls(text.replace(/\u0000/g, "")).trim();
  const rawText = cleaned.slice(0, HOUSE_RAW_TEXT_CAP) || null;
  const rawMeta = rawText
    ? JSON.stringify({
        mode: "full",
        host: "disclosures-clerk.house.gov",
        fetchedAt: iso(now),
        bytes: text.length,
        // Measured POST-strip, matching edgarBody and sourceText. Against the
        // raw courier text a filing between ~24,000 and ~24,500 characters
        // would store a complete body and stamp truncated: true.
        truncated: cleaned.length > HOUSE_RAW_TEXT_CAP,
        // Provenance: this is the courier's pypdf extraction of the filing
        // itself, not a page fetched at generation time.
        document: `${docId}.pdf`,
      })
    : null;

  await env.DB.prepare(
    `UPDATE items SET payload = ?1, score = ?2, status = ?3, raw_text = ?5, raw_meta = ?6 WHERE id = ?4`,
  )
    .bind(JSON.stringify(merged), SCORE_POSTABLE, status, row.id, rawText, rawMeta)
    .run();
  if (!fresh) {
    log("info", "house_ptr stale-at-ingest suppressed", { docId, filedDate });
  }
  return { status: status === "new" ? "queued" : "logged", docId, parsed: txns.length };
}

export async function pollHousePtr(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);
  const currentYear = now.getUTCFullYear();
  // January/February: the prior year's file still receives late filings and
  // amendments while the new year's file may not exist yet — poll both.
  const years = now.getUTCMonth() <= 1 ? [currentYear, currentYear - 1] : [currentYear];

  let failures = 0;
  let anyOk = false;
  let insertedTotal = 0;

  for (const year of years) {
    if (!budget.take(1)) {
      log("warn", "tick budget exhausted; deferring house_ptr year fetch", { year });
      break;
    }
    // Validators track only the current-year file (source_state has one slot);
    // the prior-year file is small (~52KB) and fetched unconditionally.
    const useValidators = year === currentYear;
    let res;
    try {
      res = await politeFetch(houseZipUrl(year), {
        userAgent,
        timeoutMs: 25_000,
        binary: true,
        validators: useValidators ? { etag: state.etag, lastModified: state.lastModified } : undefined,
      });
    } catch (e) {
      failures += 1;
      log("warn", "house_ptr zip fetch failed", { year, error: String(e) });
      continue;
    }

    if (res.notModified) {
      anyOk = true;
      continue;
    }
    if (res.status === 404 && year === currentYear && now.getUTCMonth() === 0) {
      // The Clerk hasn't published the new year's file yet — expected, not an
      // outage (the prior-year fetch below keeps the lake current).
      log("info", "house_ptr current-year file not yet published", { year });
      continue;
    }
    if (!res.ok || !res.bodyBytes) {
      failures += 1;
      log("warn", "house_ptr zip non-2xx", { year, status: res.status });
      continue;
    }

    try {
      const txt = new TextDecoder().decode(await unzipEntry(res.bodyBytes, `${year}FD.txt`));
      const index = parseHouseIndex(txt);
      if (index.totalDataLines === 0) {
        // A structurally empty index on a 200 is shape drift or a bad file.
        failures += 1;
        log("warn", "house_ptr index parsed to zero data lines; possible shape drift", {
          year,
          zipBytes: res.bodyBytes.byteLength,
        });
        continue;
      }
      if (index.rows.length === 0) {
        // Rows exist but none are PTRs: legitimate early-January sparsity.
        log("info", "house_ptr index has no PTR rows yet", { year, totalDataLines: index.totalDataLines });
      } else {
        insertedTotal += await ingestRows(env, index.rows, now);
      }
      anyOk = true;
      if (useValidators) {
        state.etag = res.etag;
        state.lastModified = res.lastModified;
        state.cursor = String(index.rows.length);
      }
    } catch (e) {
      failures += 1;
      log("warn", "house_ptr zip processing failed", { year, error: String(e) });
    }
  }

  if (anyOk) {
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
  } else {
    state.consecutiveFailures += failures || 1;
  }
  // DRAIN. The relay's drain enqueues at most 3 per request, and unlike every
  // other congressional source house_ptr had no second drain: pollHousePtr
  // never looked at status='new', so surplus postable filings sat unqueued
  // AND invisible to the pending endpoint (their transactions are non-null).
  // Deliberately outside the per-year loop and NOT gated on a successful ZIP
  // fetch, so a 304 or a failed fetch still drains yesterday's backlog.
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items
      WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 5`,
  )
    .bind(SOURCE, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  for (const item of pending.results) {
    if (!budget.take(1)) break;
    const parsed = JSON.parse(item.payload) as Record<string, unknown>;
    const res = await enqueueForApproval(env, item.id, "CONGRESS_PTR", parsed, item.source_url, now);
    if (res.retryAfter !== null) break;
  }

  await putSourceState(env.DB, state);
  if (insertedTotal > 0) log("info", "house_ptr poll", { inserted: insertedTotal });
}
