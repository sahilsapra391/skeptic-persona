import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { unzipEntry } from "../lib/zip";
import { getSourceState, insertItem, putSourceState, SCORE_LOG_ONLY } from "../lib/db";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// House Clerk PTR discovery (live-verified 2026-07-26; ZIP fixture captured
// 2026-07-27T04:52Z). The bulk index rebuilds ~once per weekday ~13:00 UTC;
// rows carry NO document URL and NO time-of-day. E-filed PTR PDFs
// (8-digit 200xxxxx DocIDs) are text-layer but RC4-encrypted — transaction
// extraction is the daily GitHub Actions job's work (build plan's
// heavy-parsing lane), NOT this Worker's. This ingester keeps the lake
// current at discovery level: member, filing date, document link.

export const SOURCE = "house_ptr";

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
const TXN_LINE_RE =
  /(?:^|\s)([A-Z])\s+(\d{2}\/\d{2}\/\d{4})(\d{2}\/\d{2}\/\d{4})(\$[\d,]+\s*-\s*\$[\d,]+)\s*$/;
/** Asset lines end with "(TICKER) [TYPE]"; both parts are optional in practice. */
const ASSET_TAIL_RE = /\(([A-Z.\-]{1,8})\)\s*(?:\[([A-Z]{2,3})\])?\s*$/;
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
  return (raw.replace(/\u0000/g, "").match(/\d{2}\/\d{2}\/\d{4}\d{2}\/\d{2}\/\d{4}\$/g) ?? []).length;
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
  const lines = raw.replace(/\u0000/g, "").split("\n").map((l) => l.trim());
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
      nameParts.push(inlineName);
    } else {
      // Walk BACKWARD: a wrapped asset name spans one or two lines above.
      // Stop at the previous entry's labels so a multi-transaction filing
      // cannot bleed one asset into the next.
      for (let j = i - 1; j >= 0 && nameParts.length < 2; j--) {
        const line = lines[j] ?? "";
        if (line === "" || TXN_LINE_RE.test(line)) break;
        if (/^(F\s*S\s*:|S\s*O\s*:|\$200\?|Gains)/.test(line)) break;
        nameParts.unshift(line);
      }
    }
    if (nameParts.length === 0) continue;

    let assetName = nameParts.join(" ").replace(/\s+/g, " ").trim();
    const ownerMatch = OWNER_RE.exec(assetName);
    const owner = ownerMatch?.[1] ?? "";
    if (ownerMatch) assetName = assetName.slice(ownerMatch[0].length).trim();

    const tail = ASSET_TAIL_RE.exec(assetName);
    const ticker = tail?.[1] ?? null;
    const assetType = tail?.[2] ?? null;
    if (tail) assetName = assetName.slice(0, tail.index).trim();

    out.push({
      owner,
      assetName,
      ticker,
      assetType,
      type: m[1] ?? "",
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
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdY.trim());
  if (!m) return "";
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}T00:00:00.000Z`;
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
  await putSourceState(env.DB, state);
  if (insertedTotal > 0) log("info", "house_ptr poll", { inserted: insertedTotal });
}
