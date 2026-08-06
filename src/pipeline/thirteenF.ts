import { fmtPct, fmtUsd, tickerTag } from "../ingesters/shared";

/**
 * INSTITUTIONAL_13F_BREAKDOWN payloads, built from the 13F tables.
 *
 * D-28 is the reason this file exists: the 13F lane fills `filings_13f`,
 * `holdings_13f` and `diffs_13f` and never writes to `items`, so 696 filings
 * and 9,883 holdings have produced exactly zero cards. This is the missing
 * diffs-to-payload half.
 *
 * COPY LAW, and it is the whole design. Every figure the model or the card may
 * print is a PRE-COMPUTED `*_display` string (owner ruling 2026-08-06). The
 * model does no arithmetic and no formatting; the card takes `string`, never
 * `number`. Full precision stays in the payload beside the display field so
 * the ledger keeps the real value.
 *
 * TWO FABRICATION VECTORS ARE CLOSED HERE BY CONSTRUCTION:
 *
 *  - CASHTAGS come from `cusip_map` alone. An unmapped CUSIP renders the
 *    FILED ISSUER NAME, never a guessed ticker. At 87% unmapped that is the
 *    common path, not the exception.
 *  - `sh_prn_type = 'PRN'` is a principal amount in dollars, NOT a share
 *    count. 63 rows pipeline-wide are PRN and 44 of Soros's 507 are. A draft
 *    reading "194,500,000 shares of Spotify" against a PRN row would be a
 *    false statement about what was held, so PRN rows carry an instrument
 *    label and their value is labelled principal.
 */

export interface HoldingRow {
  readonly cusip: string;
  readonly issuer: string;
  readonly value_usd: number;
  readonly shares: number | null;
  readonly sh_prn_type: string | null;
  readonly put_call: string | null;
  readonly class: string | null;
}

export interface DiffRow {
  readonly cusip: string;
  readonly issuer: string;
  readonly status: "NEW" | "ADD" | "TRIM" | "EXIT" | "UNCHANGED";
  readonly value_usd: number | null;
  readonly prev_value_usd: number | null;
  readonly pct_of_portfolio: number | null;
  readonly qoq_share_delta_pct: number | null;
  readonly put_call: string | null;
}

export interface FilingRow {
  readonly id: number;
  readonly cik: string;
  readonly manager_name: string;
  readonly form: string;
  readonly period: string;
  readonly filed_at: string;
  readonly parsed_value_total: number;
  readonly table_entry_total: number;
}

/** cusip -> ticker, from `cusip_map` and nowhere else. */
export type CusipMap = ReadonlyMap<string, string>;

/**
 * The label a row prints. A mapped CUSIP becomes a cashtag; everything else
 * is the issuer name exactly as filed.
 */
export function displayName(cusip: string, issuer: string, map: CusipMap): string {
  const t = map.get(cusip);
  return t ? tickerTag(t) : issuer;
}

/**
 * The instrument label PRN rows must carry (owner ruling 2026-08-06).
 *
 * `titleOfClass` is stored as `class`. "NOTE"/"CONV" in it means convertible
 * notes; anything else PRN falls back to the neutral "principal amount",
 * which claims less rather than guessing.
 */
export function instrumentLabel(row: { sh_prn_type: string | null; class: string | null; put_call: string | null }): string | null {
  if (row.put_call) return row.put_call.toUpperCase() === "PUT" ? "Put" : "Call";
  if ((row.sh_prn_type ?? "").toUpperCase() !== "PRN") return null;
  const cls = (row.class ?? "").toUpperCase();
  return /NOTE|CONV|DEB|BOND/.test(cls) ? "convertible notes" : "principal amount";
}

/** True when a row's quantity is a principal amount rather than a share count. */
export function isPrincipal(row: { sh_prn_type: string | null }): boolean {
  return (row.sh_prn_type ?? "").toUpperCase() === "PRN";
}

export interface SectionAggregate {
  readonly count: number;
  readonly count_display: string;
  readonly total_usd: number;
  readonly total_display: string;
  readonly pct_of_book: number | null;
  readonly pct_display: string | null;
}

function aggregate(rows: readonly DiffRow[], bookTotal: number, usePrev: boolean): SectionAggregate {
  const total = rows.reduce((n, r) => n + ((usePrev ? r.prev_value_usd : r.value_usd) ?? 0), 0);
  const pct = bookTotal > 0 ? (total / bookTotal) * 100 : null;
  return {
    count: rows.length,
    count_display: String(rows.length),
    total_usd: total,
    total_display: fmtUsd(total),
    pct_of_book: pct,
    pct_display: pct === null ? null : fmtPct(pct),
  };
}

export interface BreakdownPayload {
  readonly manager: string;
  readonly cik: string;
  readonly form: string;
  /** Both dates are REQUIRED by the copy law; a draft missing either rejects. */
  readonly asOfIso: string;
  readonly filedIso: string;
  readonly positionCount: number;
  readonly positionCount_display: string;
  readonly aum_usd: number;
  readonly aum_display: string;
  readonly top: ReadonlyArray<{
    name: string;
    value_display: string;
    pct_display: string | null;
    tag: string | null;
    principal: boolean;
  }>;
  readonly sections: {
    readonly new: SectionAggregate;
    readonly adds: SectionAggregate;
    readonly trims: SectionAggregate;
    readonly gone: SectionAggregate;
    readonly unchanged: SectionAggregate;
  };
  /** Names for the short post, already labelled. Up to three each. */
  readonly newNames: readonly string[];
  readonly goneNames: readonly string[];
}

export function buildBreakdownPayload(
  filing: FilingRow,
  holdings: readonly HoldingRow[],
  diffs: readonly DiffRow[],
  map: CusipMap,
): BreakdownPayload {
  const book = filing.parsed_value_total;
  const byStatus = (s: DiffRow["status"]) => diffs.filter((d) => d.status === s);

  const top = [...holdings]
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, 10)
    .map((h) => ({
      name: displayName(h.cusip, h.issuer, map),
      value_display: fmtUsd(h.value_usd),
      pct_display: book > 0 ? fmtPct((h.value_usd / book) * 100) : null,
      tag: instrumentLabel(h),
      principal: isPrincipal(h),
    }));

  const label = (rows: readonly DiffRow[]) =>
    rows
      .slice()
      .sort((a, b) => ((b.value_usd ?? b.prev_value_usd) ?? 0) - ((a.value_usd ?? a.prev_value_usd) ?? 0))
      .slice(0, 3)
      .map((r) => displayName(r.cusip, r.issuer, map));

  return {
    manager: filing.manager_name,
    cik: filing.cik,
    form: filing.form,
    asOfIso: filing.period,
    filedIso: filing.filed_at,
    positionCount: filing.table_entry_total,
    positionCount_display: String(filing.table_entry_total),
    aum_usd: book,
    aum_display: fmtUsd(book),
    top,
    sections: {
      new: aggregate(byStatus("NEW"), book, false),
      adds: aggregate(byStatus("ADD"), book, false),
      trims: aggregate(byStatus("TRIM"), book, false),
      // EXIT rows have no current value by definition — the position is not in
      // this filing. Their PREVIOUS value is the only honest figure, which is
      // why "gone" is a section label and never a verb: absent from a filing
      // is not the same claim as sold.
      gone: aggregate(byStatus("EXIT"), book, true),
      unchanged: aggregate(byStatus("UNCHANGED"), book, false),
    },
    newNames: label(byStatus("NEW")),
    goneNames: label(byStatus("EXIT")),
  };
}

// ---------------------------------------------------------------------------
// The diffs-to-ITEMS half. Everything above builds a payload; this is what
// makes one reach the queue, which is the other side of D-28.
// ---------------------------------------------------------------------------

/**
 * The flat payload shape the archetype and the card both read.
 *
 * Flattened deliberately: the gate DSL addresses fields by name, and nesting
 * `sections.new.count_display` behind a dotted path would make every gate a
 * special case. Full precision rides alongside each display string so the
 * ledger keeps the real number.
 */
export function flattenBreakdown(p: BreakdownPayload): Record<string, unknown> {
  return {
    manager: p.manager,
    cik: p.cik,
    form: p.form,
    asOfIso: p.asOfIso,
    filedIso: p.filedIso,
    positionCount: p.positionCount,
    positionCount_display: p.positionCount_display,
    aum_usd: p.aum_usd,
    aum_display: p.aum_display,
    newCount_display: p.sections.new.count_display,
    newTotal_display: p.sections.new.total_display,
    addsCount_display: p.sections.adds.count_display,
    addsTotal_display: p.sections.adds.total_display,
    trimsCount_display: p.sections.trims.count_display,
    trimsTotal_display: p.sections.trims.total_display,
    goneCount_display: p.sections.gone.count_display,
    goneTotal_display: p.sections.gone.total_display,
    unchangedCount_display: p.sections.unchanged.count_display,
    unchangedTotal_display: p.sections.unchanged.total_display,
    newNames: p.newNames,
    goneNames: p.goneNames,
    top: p.top,
  };
}

/** EDGAR's own filing index page. The source link every post carries. */
export function filingUrl(cik: string, accession: string): string {
  const clean = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${clean}/${accession}-index.htm`;
}
