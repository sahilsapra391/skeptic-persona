import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_LOG_ONLY } from "../lib/db";
import { ET, iso, zonedTimeToUtc } from "../lib/time";
import { log } from "../lib/log";

// EDGAR daily-index reconciliation. NOT a post source — an audit that keeps
// the five EDGAR ingesters honest.
//
// WHY IT EARNS A JOB SLOT: every EDGAR poller reads `getcurrent`, a rolling
// window that shows only the most recent N filings. If a form type spikes, or
// a poll fails, or a form-type string is subtly wrong, filings vanish with no
// error anywhere — HTTP 200, valid Atom, fewer entries. That is exactly how
// the `SCHEDULE 13D` naming bug hid (type=SC+13D returned 1 entry instead of
// 40, looking perfectly healthy).
//
// The daily index is the SEC's own census of what was actually filed. Diffing
// our lake against it turns a silent miss into a number.
//
// Verified 2026-07-28T04:14Z: 798,399 bytes for 2026-07-27, fixed-width, and
// the day's census was Form 4 588, SCHEDULE 13G 432, 13F-HR 297, 8-K 226,
// Form 144 166.
export const SOURCE = "edgar_reconcile";

/** Index form type -> the items.source that should have captured it. */
export const TRACKED: ReadonlyArray<{ formPrefix: string; source: string; label: string }> = [
  { formPrefix: "8-K", source: "edgar_8k", label: "8-K" },
  { formPrefix: "4", source: "edgar_form4", label: "Form 4" },
  { formPrefix: "144", source: "sec_form144", label: "Form 144" },
  { formPrefix: "SCHEDULE 13D", source: "sec_schedule13", label: "Schedule 13D" },
  { formPrefix: "SCHEDULE 13G", source: "sec_schedule13", label: "Schedule 13G" },
];

/** Below this share of the SEC's own count, the gap is worth surfacing. */
export const COVERAGE_ALARM = 0.5;

export function indexUrlFor(d: Date): string {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${y}${mm}${dd}.idx`;
}

/**
 * Count filings per form type. The file is FIXED-WIDTH, not delimited: the
 * form type occupies the first 12 columns and company names contain spaces,
 * so any whitespace split mis-parses it.
 */
export function countByForm(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith("---"));
  if (start < 0) return counts;
  for (const line of lines.slice(start + 1)) {
    if (line.length < 13) continue;
    const form = line.slice(0, 12).trim();
    if (form === "") continue;
    counts.set(form, (counts.get(form) ?? 0) + 1);
  }
  return counts;
}

export interface CoverageRow {
  label: string;
  source: string;
  secCount: number;
  ourCount: number;
  coverage: number | null;
}

export async function pollEdgarReconcile(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, SOURCE);

  // Audit YESTERDAY: today's index is still being written.
  const target = new Date(now.getTime() - 86_400_000);
  const dayIso = target.toISOString().slice(0, 10);

  try {
    const res = await politeFetch(indexUrlFor(target), {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 30_000,
    });
    // Weekends and holidays have no index; that is not a failure.
    if (res.status === 404) {
      log("info", "no edgar index for date (weekend or holiday)", { date: dayIso });
      state.lastOkAt = iso(now);
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
      return;
    }
    if (!res.ok) throw new Error(`edgar index ${res.status}`);

    const counts = countByForm(res.body);
    if (counts.size === 0) throw new Error("index parsed to zero form types");

    // The filing DAY is Eastern; our event_at is UTC. Compare on the ET
    // window or filings after 20:00 ET land on the wrong side of the boundary.
    const from = zonedTimeToUtc(ET, target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), 0, 0, 0);
    const to = new Date(from.getTime() + 86_400_000);

    const rows: CoverageRow[] = [];
    for (const t of TRACKED) {
      const secCount = counts.get(t.formPrefix) ?? 0;
      const ours = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM items WHERE source = ?1 AND event_at >= ?2 AND event_at < ?3`,
      )
        .bind(t.source, iso(from), iso(to))
        .first<{ n: number }>();
      const ourCount = ours?.n ?? 0;
      rows.push({
        label: t.label,
        source: t.source,
        secCount,
        ourCount,
        coverage: secCount > 0 ? Math.round((ourCount / secCount) * 1000) / 1000 : null,
      });
    }

    for (const r of rows) {
      if (r.coverage !== null && r.secCount >= 20 && r.coverage < COVERAGE_ALARM) {
        log("warn", "edgar coverage gap", {
          form: r.label,
          date: dayIso,
          sec: r.secCount,
          ours: r.ourCount,
          coverage: r.coverage,
        });
      }
    }

    // Stored as a lake item so the history is queryable. Never postable: this
    // is our own bookkeeping, not news about the world.
    await insertItem(
      env.DB,
      {
        source: SOURCE,
        externalId: dayIso,
        category: "audit",
        eventAt: `${dayIso}T00:00:00.000Z`,
        sourceUrl: indexUrlFor(target),
        payload: { date: dayIso, rows, totalFormTypes: counts.size },
        score: SCORE_LOG_ONLY,
        status: "logged",
      },
      now,
    );

    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    log("info", "edgar reconciliation", { date: dayIso, rows });
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    await recordSourceError(env.DB, SOURCE, e, now);
    log("error", "edgar reconcile failed", { error: String(e) });
  }
}
