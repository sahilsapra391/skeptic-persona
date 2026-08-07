import { decodeEntities, extractAll, extractAttr, extractFirst, stripBom } from "../lib/xml";

/**
 * Shared parser for EDGAR's `action=getcurrent` Atom feed, for any form type.
 *
 * `edgar8k.ts` has parsed this shape since the beginning, but its `TITLE_RE`
 * hard-codes both the form (`8-K`) and the role (`(Filer)`). Neither
 * generalises, and the role in particular is load-bearing for p5-31:
 *
 *   S-1     - Ionetix Corp / DE / (0002108121) (Filer)
 *   DFAN14A - TOMS Capital Investment Management LP (0001743937) (Filed by)
 *
 * **`(Filed by)` is not decoration.** On a proxy solicitation it means the
 * filing came from someone other than the company — an activist soliciting
 * against management — which is the entire signal the proxy-contest lane
 * exists to catch. A parser that only accepts `(Filer)` drops exactly the
 * filings that matter.
 *
 * Verified live 2026-08-07 against seven form types (S-1, S-1/A, 424B4,
 * DEFC14A, PREC14A, DFAN14A, DEF 14A); all 200 `application/atom+xml`.
 */

/** `(Filer)` = the subject company filed it. `(Filed by)` = a third party did. */
export type FilerRole = "filer" | "filed_by";

export interface EdgarFormEntry {
  readonly formType: string;
  /** The FILING party: `(Filer)` or `(Filed by)`. On a contested proxy this is
   *  the activist, not the target. */
  readonly company: string;
  readonly cik: string;
  readonly role: FilerRole;
  /** The `(Subject)` company, when EDGAR emits one. Null on ordinary filings. */
  readonly subjectCompany: string | null;
  readonly subjectCik: string | null;
  readonly accession: string;
  readonly indexUrl: string;
  readonly filedIso: string | null;
}

// Deliberately NOT anchored to a form list: the caller asked EDGAR for a form
// type, so whatever comes back is that type. Anchoring here would mean two
// places to edit every time a lane adds a form.
const TITLE_RE = /^(.+?) - (.+) \((\d{10})\) \((Filer|Filed by|Subject)\)$/;
const ACCESSION_RE = /accession-number=([0-9-]+)/;

const ROLE: Record<string, FilerRole> = { Filer: "filer", "Filed by": "filed_by", Subject: "filer" };

export function parseEdgarFormFeed(xml: string): EdgarFormEntry[] {
  // ONE ACCESSION CAN APPEAR TWICE, and dropping either half loses the story.
  // Measured live 2026-08-07 on DFAN14A: every one of three filings came back
  // as a PAIR, once under the activist and once under the target.
  //
  //   0001140361-26-031676  Filed by  TOMS Capital Investment Management LP
  //                         Subject   Voya Financial, Inc.
  //
  // Deduping to whichever row arrives first is non-deterministic AND wrong for
  // p5-31: if the `Subject` row wins, the 13D cross-reference looks up the
  // TARGET COMPANY's CIK instead of the activist's, and silently finds nothing
  // (or worse, finds the company's own filing). So the pair is merged into one
  // entry that carries both sides.
  const rows: Array<{ e: EdgarFormEntry; isSubject: boolean }> = [];
  for (const entry of extractAll(stripBom(xml), "entry")) {
    const accession = ACCESSION_RE.exec(extractFirst(entry, "id") ?? "")?.[1];
    if (!accession) continue;
    const title = decodeEntities(extractFirst(entry, "title") ?? "").trim();
    const m = TITLE_RE.exec(title);
    // A title that does not match is SKIPPED, not guessed at. EDGAR
    // occasionally emits paper filings and index rows through the same feed,
    // and a row with no CIK cannot be attributed to anyone at all.
    if (!m) continue;
    const indexUrl = extractAttr(entry, "link", "href") ?? "";
    if (!indexUrl) continue;
    const updated = extractFirst(entry, "updated");
    const parsed = updated ? Date.parse(updated) : NaN;
    const isSubject = m[4] === "Subject";
    rows.push({
      isSubject,
      e: {
        formType: m[1]!.trim(),
        company: m[2]!.trim(),
        cik: m[3]!,
        role: ROLE[m[4]!] ?? "filer",
        subjectCompany: null,
        subjectCik: null,
        accession,
        indexUrl,
        filedIso: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
      },
    });
  }

  const merged = new Map<string, EdgarFormEntry>();
  // Filing parties first, so the surviving `company`/`cik` is always the party
  // that FILED. A subject-only accession still yields an entry rather than
  // being dropped, because a filing we cannot attribute to an activist is
  // still a filing that happened.
  for (const { e, isSubject } of rows) {
    if (isSubject) continue;
    if (!merged.has(e.accession)) merged.set(e.accession, e);
  }
  for (const { e, isSubject } of rows) {
    if (!isSubject) continue;
    const existing = merged.get(e.accession);
    if (existing) {
      merged.set(e.accession, { ...existing, subjectCompany: e.company, subjectCik: e.cik });
    } else {
      merged.set(e.accession, e);
    }
  }
  return [...merged.values()];
}

const BASE = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&company=&dateb=&owner=include&output=atom";

/** Feed URL for one form type. `type` is sent verbatim, URL-encoded. */
export function formFeedUrl(formType: string, count = 40): string {
  return `${BASE}&type=${encodeURIComponent(formType)}&count=${count}`;
}
