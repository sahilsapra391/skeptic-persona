import type { Env } from "../env";
import { gateContext, issuerGate } from "./issuers";
import { fetchPool, newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAllNs, extractAttr, extractFirst, extractFirstNs, stripBom } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { recordFacts } from "../lookback";
import { enqueueForApproval } from "../pipeline/enqueue";
import { fmtNum, isFreshAtIngest } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// SEC Schedule 13D / 13G — beneficial ownership above 5%.
//
// THE NAMING TRAP, re-verified live 2026-07-28T01:03Z: the EDGAR form type is
// literally "SCHEDULE 13D", not "SC 13D". Querying getcurrent with
// type=SC+13D returned ONE entry; type=SCHEDULE+13D returned FORTY. A poller
// built on the obvious spelling looks perfectly healthy — HTTP 200, valid
// Atom, no error — while missing ~99% of filings.
const FEED_BASE =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&company=&dateb=&owner=include&output=atom&count=40";
export const SCHEDULE_13D_FEED = `${FEED_BASE}&type=SCHEDULE+13D`;
export const SCHEDULE_13G_FEED = `${FEED_BASE}&type=SCHEDULE+13G`;

export const SOURCE = "sec_schedule13";

/** A stake at or above this share of the class is alert grade. */
export const BIG_STAKE_PCT = 10;
export const DETAIL_BATCH_PER_RUN = 8;
export const MAX_DETAIL_ATTEMPTS = 3;
export const MAX_ENQUEUES_PER_RUN = 3;

export interface Schedule13Entry {
  accession: string;
  formType: string; // SCHEDULE 13D | SCHEDULE 13D/A | SCHEDULE 13G | ...
  dirUrl: string;
  indexUrl: string;
  filedIso: string;
}

const ACCESSION_RE = /accession-number=([0-9-]+)/;

/**
 * VERIFIED QUIRK: one filing appears twice per page, once under the reporting
 * person ("(Filed by)") and once under the issuer ("(Subject)"), sharing an
 * accession. Dedup or every stake posts twice.
 */
export function parse13Feed(xml: string): Schedule13Entry[] {
  const out: Schedule13Entry[] = [];
  const seen = new Set<string>();
  for (const entry of extractAllNs(stripBom(xml), "entry")) {
    const accession = ACCESSION_RE.exec(extractFirst(entry, "id") ?? "")?.[1];
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    const indexUrl = extractAttr(entry, "link", "href") ?? "";
    if (!indexUrl) continue;
    const title = decodeEntities(extractFirst(entry, "title") ?? "");
    const formType = (/^([A-Z0-9/ ]+?)\s+-\s+/.exec(title)?.[1] ?? "").trim() || "SCHEDULE 13D";
    const updated = extractFirst(entry, "updated") ?? "";
    const filedAt = new Date(updated);
    out.push({
      accession,
      formType,
      indexUrl,
      dirUrl: indexUrl.replace(/\/[^/]*$/, ""),
      filedIso: Number.isNaN(filedAt.getTime()) ? "" : filedAt.toISOString(),
    });
  }
  return out;
}

export interface ReportingPerson {
  name: string;
  cik: string | null;
  type: string | null; // IN, CO, PN, IA, BD, HC...
  aggregateAmountOwned: number | null;
  percentOfClass: number | null;
  soleVotingPower: number | null;
  sharedVotingPower: number | null;
}

export interface Schedule13Doc {
  issuerCik: string;
  issuerName: string;
  cusip: string | null;
  securitiesClass: string | null;
  /** The triggering date — this is the disclosure-lag clock. */
  dateOfEvent: string | null;
  dateOfEventIso: string | null;
  previouslyFiled: boolean | null;
  persons: ReportingPerson[];
  /** Largest percentOfClass across reporting persons, when parsed. */
  topPercent: number | null;
  topPersonName: string | null;
}

const numOf = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number.parseFloat(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** MM/DD/YYYY -> ISO, round-trip validated. */
export function eventDateToIso(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const iso = `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCMonth() + 1 !== Number(m[1]) || d.getUTCDate() !== Number(m[2])) return null;
  return iso;
}

export function parse13Xml(xml: string): Schedule13Doc | null {
  const clean = stripBom(xml);
  const issuerCik = (extractFirstNs(clean, "issuerCIK") ?? "").trim();
  const issuerName = decodeEntities((extractFirstNs(clean, "issuerName") ?? "").trim());
  if (!issuerCik || !issuerName) return null;

  // Cover-page numbers live per reporting person; narrative Items are
  // unreliable ("See Item 3 above") and are never read for a number.
  const persons: ReportingPerson[] = extractAllNs(clean, "reportingPersonInfo").map((b) => ({
    name: decodeEntities((extractFirstNs(b, "reportingPersonName") ?? "").trim()),
    cik: (extractFirstNs(b, "reportingPersonCIK") ?? "").trim() || null,
    type: (extractFirstNs(b, "typeOfReportingPerson") ?? "").trim() || null,
    aggregateAmountOwned: numOf(extractFirstNs(b, "aggregateAmountOwned")),
    percentOfClass: numOf(extractFirstNs(b, "percentOfClass")),
    soleVotingPower: numOf(extractFirstNs(b, "soleVotingPower")),
    sharedVotingPower: numOf(extractFirstNs(b, "sharedVotingPower")),
  }));

  const withPct = persons.filter((p) => p.percentOfClass !== null && p.name !== "");
  const top = withPct.length > 0 ? withPct.reduce((a, b) => ((a.percentOfClass ?? 0) >= (b.percentOfClass ?? 0) ? a : b)) : null;
  const dateOfEvent = (extractFirstNs(clean, "dateOfEvent") ?? "").trim() || null;
  const prevRaw = (extractFirstNs(clean, "previouslyFiledFlag") ?? "").trim().toLowerCase();

  return {
    issuerCik,
    issuerName,
    cusip: (extractFirstNs(clean, "issuerCusipNumber") ?? "").trim() || null,
    securitiesClass: decodeEntities((extractFirstNs(clean, "securitiesClassTitle") ?? "").trim()) || null,
    dateOfEvent,
    dateOfEventIso: eventDateToIso(dateOfEvent),
    previouslyFiled: prevRaw === "" ? null : prevRaw === "true",
    persons,
    topPercent: top?.percentOfClass ?? null,
    topPersonName: top?.name ?? null,
  };
}

export function score13(doc: Schedule13Doc, formType: string): number {
  // A stake we cannot size is never postable.
  if (doc.topPercent === null || !doc.topPersonName) return SCORE_LOG_ONLY;
  // 13D means an ACTIVIST intent filing; 13G is passive.
  const isD = /13D/i.test(formType);
  if (isD && doc.topPercent >= BIG_STAKE_PCT) return SCORE_AUTO_ALERT;
  if (isD) return SCORE_POSTABLE;
  if (doc.topPercent >= BIG_STAKE_PCT) return SCORE_POSTABLE;
  return SCORE_LOG_ONLY;
}

export function draft13(doc: Schedule13Doc, formType: string): string {
  const kind = /13D/i.test(formType) ? "13D" : "13G";
  const amended = formType.endsWith("/A") ? " amendment" : "";
  const size =
    doc.persons.find((p) => p.name === doc.topPersonName)?.aggregateAmountOwned ?? null;
  const shares = size !== null ? `${fmtNum(size)} shares, ` : "";
  const when = doc.dateOfEvent ? `, event dated ${doc.dateOfEvent}` : "";
  return `Schedule ${kind}${amended}: ${doc.topPersonName} reports ${shares}${doc.topPercent}% of ${doc.issuerName}${when}`;
}

export async function pollSchedule13(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);
  const state = await getSourceState(env.DB, SOURCE);

  // Both spellings, both forms. NOTE the type strings: "SCHEDULE 13D", never
  // "SC 13D" (see the comment on the feed constants).
  for (const feed of [SCHEDULE_13D_FEED, SCHEDULE_13G_FEED]) {
    if (!budget.take(1)) break;
    try {
      const res = await politeFetch(feed, { userAgent, timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const entries = parse13Feed(res.body);
      if (entries.length === 0) throw new Error("feed parsed to zero entries");

      for (const e of entries) {
        await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: e.accession,
            category: "ownership",
            eventAt: e.filedIso || null,
            sourceUrl: e.indexUrl,
            payload: { phase: "stub", dirUrl: e.dirUrl, accession: e.accession, formType: e.formType },
            score: SCORE_LOG_ONLY,
            // The feed carries no numbers at all, so nothing is postable
            // until the cover page is parsed.
            status: isFreshAtIngest(e.filedIso, now) ? "pending_detail" : "logged",
          },
          now,
        );
      }
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
    } catch (err) {
      state.consecutiveFailures += 1;
      log("error", "schedule 13 feed failed", { feed, error: String(err) });
    }
  }
  state.lastPolledAt = iso(now);
  await putSourceState(env.DB, state);

  await processDetails(env, userAgent, now, budget);
  await drainPostables(env, now, budget);
}

async function processDetails(env: Env, userAgent: string, now: Date, budget: TickBudget): Promise<void> {
  // ONCE per batch: see gateContext. Per filing this is a full table scan.
  const ctx = await gateContext(env, now);
  const pending = await env.DB.prepare(
    `SELECT id, payload, event_at FROM items WHERE source = ?1 AND status = 'pending_detail' ORDER BY id LIMIT ?2`,
  )
    .bind(SOURCE, DETAIL_BATCH_PER_RUN)
    .all<{ id: number; payload: string; event_at: string | null }>();
  if (pending.results.length === 0) return;

  const affordable = pending.results.filter(() => budget.take(1));
  if (affordable.length === 0) return;

  await fetchPool(affordable, async (row) => {
    let attempts = 0;
    try {
      const stub = JSON.parse(row.payload) as { dirUrl: string; accession: string; formType: string; attempts?: number };
      attempts = stub.attempts ?? 0;
      const res = await politeFetch(`${stub.dirUrl}/primary_doc.xml`, { userAgent, timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`primary_doc ${res.status}`);
      const doc = parse13Xml(res.body);
      if (!doc) throw new Error("primary_doc did not parse");

      let score = score13(doc, stub.formType);
      // ISSUER GATE. Same reference the 8-K lane uses, same fail-open rules.
      // The filing still lands in the lake; it just stops interrupting.
      const gate = await issuerGate(env, doc.issuerCik, ctx);
      if (!gate.keep) {
        score = Math.min(score, SCORE_LOG_ONLY);
        log("debug", "schedule13 suppressed by issuer gate", { cik: doc.issuerCik, reason: gate.reason });
      }
      const fresh = isFreshAtIngest(row.event_at ?? "", now);
      await env.DB.prepare(
        `UPDATE items SET payload = ?1, score = ?2, status = ?3 WHERE id = ?4 AND status = 'pending_detail'`,
      )
        .bind(
          JSON.stringify({
            phase: "detail",
            formType: stub.formType,
            isAmendment: stub.formType.endsWith("/A"),
            // Parsed at ingest so the beat gates on a boolean, not on a
            // form-type string re-read at render time.
            isSchedule13D: /13D/i.test(stub.formType),
            ...doc,
            factLine: draft13(doc, stub.formType),
          }),
          score,
          score >= SCORE_POSTABLE && fresh ? "new" : "logged",
          row.id,
        )
        .run();

      if (doc.topPercent !== null && doc.dateOfEventIso) {
        await recordFacts(
          env.DB,
          [
            {
              itemId: row.id,
              source: SOURCE,
              entity: doc.issuerCik,
              metric: "stake_pct",
              value: doc.topPercent,
              occurredAt: `${doc.dateOfEventIso}T00:00:00.000Z`,
            },
          ],
          now,
        );
      }
    } catch (err) {
      const next = attempts + 1;
      const giveUp = next >= MAX_DETAIL_ATTEMPTS;
      log(giveUp ? "warn" : "info", "schedule 13 detail failed", { itemId: row.id, attempt: next, error: String(err) });
      await env.DB.prepare(
        `UPDATE items SET payload = json_set(payload, '$.attempts', ?1), status = ?2
         WHERE id = ?3 AND status = 'pending_detail'`,
      )
        .bind(next, giveUp ? "logged" : "pending_detail", row.id)
        .run()
        .catch(() => {});
    }
  });
}

async function drainPostables(env: Env, now: Date, budget: TickBudget): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items
     WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT ?3`,
  )
    .bind(SOURCE, SCORE_POSTABLE, MAX_ENQUEUES_PER_RUN)
    .all<{ id: number; source_url: string; payload: string }>();

  const spacingRaw = Number(env.QUEUE_NOTIFY_SPACING_MS ?? 1100);
  const spacingMs = Number.isFinite(spacingRaw) && spacingRaw >= 0 ? spacingRaw : 1100;
  let sent = 0;
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "OWNERSHIP_STAKE", payload, row.source_url, now);
    sent += 1;
    if (result.retryAfter !== null) break;
    if (spacingMs > 0 && sent < pending.results.length) {
      await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
  }
}
