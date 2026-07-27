import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { recordFacts } from "../lookback";
import { enqueueForApproval } from "../pipeline/enqueue";
import { fmtNum } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// FDA drug enforcement reports (recalls). Live-verified 2026-07-27T22:49Z:
// 200, flat typed records, sorted newest-first by report_date.
//
// WHY THIS SOURCE: it is the rare feed that hands us the disclosure lag for
// free. recall_initiation_date is when the firm started pulling product;
// report_date is when FDA published it. The gap between them is a parsed
// fact, and "disclosed N days later" is the wire's signature move.
//
// QUOTA NOTE: openFDA rate-limits per IP and Cloudflare egress IPs are
// SHARED, so a burst from any Worker on the platform counts against us. This
// polls twice a day and treats 429 as a soft failure.
export const FDA_RECALLS =
  "https://api.fda.gov/drug/enforcement.json?limit=30&sort=report_date:desc";
export const FDA_PAGE = "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts";

export const SOURCE = "fda_drug_recall";

export interface FdaRecall {
  eventId: string;
  firm: string;
  /** FDA's own words: "Class I" is the most serious. */
  classification: string;
  status: string;
  reason: string;
  product: string;
  quantity: string | null;
  distribution: string | null;
  voluntary: string | null;
  initiatedIso: string | null;
  reportedIso: string | null;
  /** Days from the firm starting the recall to FDA publishing it. */
  disclosureLagDays: number | null;
}

/** openFDA serves dates as YYYYMMDD strings. */
export function fdaDateToIso(v: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip so 20260230 cannot roll forward into March.
  if (d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) return null;
  return iso;
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const d = Math.round((b - a) / 86_400_000);
  return d >= 0 ? d : null;
}

const str = (v: unknown): string => String(v ?? "").trim();

export function parseRecalls(body: string): FdaRecall[] {
  const doc = JSON.parse(body) as { results?: Array<Record<string, unknown>> };
  const out: FdaRecall[] = [];
  for (const r of doc.results ?? []) {
    const firm = str(r.recalling_firm);
    const classification = str(r.classification);
    const eventId = str(r.event_id);
    // A recall we cannot name or grade is not publishable.
    if (!firm || !classification || !eventId) continue;

    const initiatedIso = fdaDateToIso(r.recall_initiation_date);
    const reportedIso = fdaDateToIso(r.report_date);
    out.push({
      eventId,
      firm,
      classification,
      status: str(r.status),
      reason: str(r.reason_for_recall),
      product: str(r.product_description),
      quantity: str(r.product_quantity) || null,
      distribution: str(r.distribution_pattern) || null,
      voluntary: str(r.voluntary_mandated) || null,
      initiatedIso,
      reportedIso,
      disclosureLagDays: initiatedIso && reportedIso ? daysBetween(initiatedIso, reportedIso) : null,
    });
  }
  return out;
}

/**
 * Grading uses FDA's OWN classification, never our reading of the reason
 * text. Class I is FDA's term for a reasonable probability of serious harm.
 */
export function scoreRecall(r: FdaRecall): number {
  if (!r.reason || !r.product) return SCORE_LOG_ONLY;
  if (r.classification === "Class I") return SCORE_AUTO_ALERT;
  if (r.classification === "Class II") return SCORE_POSTABLE;
  return SCORE_LOG_ONLY;
}

/** Tier A: FDA's fields, verbatim. The reason text is the agency's wording. */
export function draftRecall(r: FdaRecall): string {
  // Truncate with a single character rather than "...": a period-collapsing
  // cleanup would eat an ellipsis, and the join below already normalises
  // trailing periods per part.
  const product = r.product.length > 90 ? `${r.product.slice(0, 89)}\u2026` : r.product;
  const parts = [`FDA ${r.classification} recall: ${r.firm}`, product, `Reason: ${r.reason}`];
  if (r.initiatedIso) parts.push(`Initiated ${r.initiatedIso}`);
  return parts.map((p) => p.replace(/\.\s*$/, "")).join(". ");
}

export async function pollFdaRecalls(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, SOURCE);
  try {
    const res = await politeFetch(FDA_RECALLS, { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000 });
    // Shared-IP quota: a 429 is not a broken source, it is a busy neighbour.
    if (res.status === 429) {
      log("warn", "openFDA rate limited (shared egress IP); backing off", { status: res.status });
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
      return;
    }
    if (!res.ok) throw new Error(`fda ${res.status}`);
    const recalls = parseRecalls(res.body);
    if (recalls.length === 0) throw new Error("parsed to zero recalls");

    for (const r of recalls) {
      const score = scoreRecall(r);
      const result = await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: `${r.eventId}:${r.product.slice(0, 40)}`,
          category: "recall",
          eventAt: r.reportedIso ? `${r.reportedIso}T00:00:00.000Z` : null,
          sourceUrl: FDA_PAGE,
          payload: {
            ...r,
            // Derived at PARSE time from FDA's own field so the beat gates on
            // a boolean rather than re-reading prose at render.
            voluntaryIsFirmInitiated: /firm initiated/i.test(r.voluntary ?? ""),
            factLine: draftRecall(r),
          },
          score,
          status: score >= SCORE_POSTABLE ? "new" : "logged",
        },
        now,
      );
      if (result.outcome === "inserted" && result.id !== null && r.disclosureLagDays !== null && r.reportedIso) {
        await recordFacts(
          env.DB,
          [
            {
              itemId: result.id,
              source: SOURCE,
              entity: r.firm,
              metric: "recall_disclosure_lag_days",
              value: r.disclosureLagDays,
              occurredAt: `${r.reportedIso}T00:00:00.000Z`,
            },
          ],
          now,
        );
      }
    }
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    log("error", "fda recall poll failed", { error: String(e), failures: state.consecutiveFailures });
    return;
  }

  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 3`,
  )
    .bind(SOURCE, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "PRODUCT_RECALL", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
