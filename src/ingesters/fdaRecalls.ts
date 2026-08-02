import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE ,
  recordSourceError,
} from "../lib/db";
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

/**
 * openFDA enforcement datasets, as a declarative family. Both serve the SAME
 * record shape under the same field names, so one parser and one grouper
 * cover them; the only per-dataset decision is which FDA grades are worth
 * interrupting the owner for.
 */
export interface FdaEnforcementSource {
  /** items.source and the D1 job name. */
  id: string;
  /** What is being recalled, in the post's own words. */
  kind: string;
  url: string;
  pageUrl: string;
  /**
   * FDA classifications allowed to reach the approval queue. Everything else
   * still lands in the lake.
   *
   * Drug takes Class I and II: a sterility failure or a CGMP deviation names
   * a manufacturer that is usually a listed company, which is what this
   * account is about. Food takes Class I ONLY. Measured 2026-07-28, food
   * Class II runs ~33 grouped events a month, mostly undeclared allergens at
   * regional producers -- real public-health notices, but not market
   * intelligence, and the queue already expires more cards than it approves.
   */
  postableGrades: readonly string[];
}

export const FDA_SOURCES: readonly FdaEnforcementSource[] = [
  {
    id: SOURCE,
    kind: "drug",
    url: FDA_RECALLS,
    pageUrl: FDA_PAGE,
    postableGrades: ["Class I", "Class II"],
  },
  {
    id: "fda_food_recall",
    kind: "food",
    url: "https://api.fda.gov/food/enforcement.json?limit=30&sort=report_date:desc",
    pageUrl: FDA_PAGE,
    postableGrades: ["Class I"],
  },
  {
    id: "fda_device_recall",
    kind: "device",
    url: "https://api.fda.gov/device/enforcement.json?limit=30&sort=report_date:desc",
    pageUrl: "https://www.fda.gov/medical-devices/medical-device-recalls",
    /**
     * Class I ONLY, and the measurement says so rather than the analogy to
     * food. Counted 2026-08-01 over 2026-05-01..08-01:
     *
     *   Class I    151 rows ->  38 events  (~13/month)
     *   Class II   640 rows -> 200 events  (~67/month)
     *   Class III    2 rows
     *
     * 67 events a month is DOUBLE the food Class II rate that got food
     * capped, and the queue already expires more cards than it approves.
     *
     * The severity split lines up with the firms. Class I over that window
     * is Arrow International, Abiomed, Becton Dickinson, Medline, Argon --
     * device makers whose recalls move the maker. Class II is dominated by
     * one firm (Medline, 189 of 640 rows) and runs to calibration drift and
     * labelling, which is a real safety notice and not market intelligence.
     */
    postableGrades: ["Class I"],
  },
];

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
 * One recall EVENT, as FDA itself identifies it.
 *
 * openFDA publishes one record PER PRODUCT, so a single recall arrives as
 * many near-identical rows: measured 2026-07-28, a 199-record drug window
 * held 94 events and one Bell Pharmaceuticals recall alone accounted for 11
 * rows. Ungrouped, that is eleven approval cards for one recall.
 */
export interface FdaRecallEvent extends FdaRecall {
  /** Records FDA published under this event, classification and reason. */
  productCount: number;
  /** Every product in the group, in the order FDA served them. */
  products: string[];
}

/**
 * Collapse per-product records into events.
 *
 * The key is FDA's own event_id PLUS classification and reason, and that is
 * not belt-and-braces. Measured across a 307-record food window and a
 * 199-record drug window: recalling_firm, status, recall_initiation_date and
 * report_date NEVER vary inside an event_id, but classification varies in
 * about 9% of multi-record events and reason_for_recall in 12-25%. Grouping
 * on event_id alone would therefore print one classification over products
 * FDA graded differently, which is a mis-statement of the agency's own call.
 *
 * With the composite key, every merged field is consistent by construction:
 * zero inconsistent groups across both windows.
 */
export function groupRecalls(recalls: readonly FdaRecall[]): FdaRecallEvent[] {
  const groups = new Map<string, FdaRecallEvent>();
  for (const r of recalls) {
    const key = eventKey(r);
    const existing = groups.get(key);
    if (existing) {
      existing.productCount += 1;
      existing.products.push(r.product);
      continue;
    }
    groups.set(key, { ...r, productCount: 1, products: [r.product] });
  }
  return [...groups.values()];
}

/**
 * Stable identity for one event-classification-reason group.
 *
 * The reason is truncated but included: if FDA restates why a product was
 * pulled, that is a different claim and deserves its own item rather than
 * silently reusing the old one.
 */
export function eventKey(r: FdaRecall): string {
  return `${r.eventId}:${r.classification}:${r.reason.slice(0, 60)}`;
}

/**
 * Grading uses FDA's OWN classification, never our reading of the reason
 * text. Class I is FDA's term for a reasonable probability of serious harm.
 */
export function scoreRecall(r: FdaRecall, src?: FdaEnforcementSource): number {
  if (!r.reason || !r.product) return SCORE_LOG_ONLY;
  // The GRADE is FDA's. Which grades are worth the owner's attention is ours,
  // and it differs by dataset, so it is declared per source rather than
  // decided here.
  const allowed = src?.postableGrades ?? ["Class I", "Class II"];
  if (!allowed.includes(r.classification)) return SCORE_LOG_ONLY;
  if (r.classification === "Class I") return SCORE_AUTO_ALERT;
  if (r.classification === "Class II") return SCORE_POSTABLE;
  return SCORE_LOG_ONLY;
}

/** Tier A: FDA's fields, verbatim. The reason text is the agency's wording. */
export function draftRecall(r: FdaRecall | FdaRecallEvent, kind = "drug"): string {
  // Truncate with a single character rather than "...": a period-collapsing
  // cleanup would eat an ellipsis, and the join below already normalises
  // trailing periods per part.
  const product = r.product.length > 90 ? `${r.product.slice(0, 89)}\u2026` : r.product;
  // A grouped event names one product and SAYS how many more it covers. A
  // count without the marker would read as a single-product recall.
  const count = "productCount" in r ? r.productCount : 1;
  const listed = count > 1 ? `${product} +${count - 1} more products` : product;
  const parts = [`FDA ${r.classification} ${kind} recall: ${r.firm}`, listed, `Reason: ${r.reason}`];
  if (r.initiatedIso) parts.push(`Initiated ${r.initiatedIso}`);
  return parts.map((p) => p.replace(/\.\s*$/, "")).join(". ");
}

export function makeFdaHandler(src: FdaEnforcementSource) {
  return (env: Env, now: Date = new Date(), budget: TickBudget = newTickBudget()): Promise<void> =>
    pollFdaEnforcement(env, src, now, budget);
}

export async function pollFdaEnforcement(
  env: Env,
  src: FdaEnforcementSource,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, src.id);
  try {
    const res = await politeFetch(src.url, { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000 });
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

    // One card per EVENT, not per product record.
    const events = groupRecalls(recalls);
    log("info", "fda recalls grouped", { source: src.id, records: recalls.length, events: events.length });

    for (const r of events) {
      const score = scoreRecall(r, src);
      const result = await insertItem(
        env.DB,
        {
          source: src.id,
          externalId: eventKey(r),
          category: "recall",
          eventAt: r.reportedIso ? `${r.reportedIso}T00:00:00.000Z` : null,
          sourceUrl: src.pageUrl,
          payload: {
            ...r,
            // Derived at PARSE time from FDA's own field so the beat gates on
            // a boolean rather than re-reading prose at render.
            voluntaryIsFirmInitiated: /firm initiated/i.test(r.voluntary ?? ""),
            kind: src.kind,
            factLine: draftRecall(r, src.kind),
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
              source: src.id,
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
    await recordSourceError(env.DB, src.id, e, now);
    log("error", "fda recall poll failed", { source: src.id, error: String(e), failures: state.consecutiveFailures });
    return;
  }

  // src.id, NOT the SOURCE constant. SOURCE is "fda_drug_recall"; this
  // function is the per-source fan-out, so binding the constant made EVERY
  // lane drain the drug lane.
  //
  // fda_food_recall has therefore never drained its own items since it
  // shipped (4ac245f, migration 0041). Class I food recalls insert with
  // status='new', the food poll enqueues drug rows instead, and the food
  // rows are never selected again -- they sit at 'new' permanently, and the
  // dedup key stops re-ingest from creating a second chance.
  //
  // Nothing surfaced it: the poll succeeds, items land in the lake, the
  // source-health counters stay green, and the only symptom is cards that
  // never appear for a lane nobody was watching.
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 3`,
  )
    .bind(src.id, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "PRODUCT_RECALL", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
