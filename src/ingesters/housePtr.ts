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
