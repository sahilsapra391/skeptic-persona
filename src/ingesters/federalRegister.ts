import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { recordFacts } from "../lookback";
import { enqueueForApproval } from "../pipeline/enqueue";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Federal Register presidential documents. Live-verified 2026-07-27T22:52Z:
// 200, 6,763 documents available, newest page carried three tariff
// proclamations and one executive order.
//
// WHY: tariffs are imposed by PROCLAMATION and trade policy moves by
// EXECUTIVE ORDER. Both are the primary document itself, not somebody's
// report of it — which is the whole difference between this wire and the
// accounts that post "per WSJ".
export const FEDREG_PRESIDENTIAL =
  "https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest" +
  "&conditions%5Bpresidential_document_type%5D%5B%5D=executive_order" +
  "&conditions%5Bpresidential_document_type%5D%5B%5D=proclamation" +
  "&conditions%5Bpresidential_document_type%5D%5B%5D=determination" +
  "&fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=type&fields%5B%5D=subtype" +
  "&fields%5B%5D=publication_date&fields%5B%5D=signing_date&fields%5B%5D=executive_order_number" +
  "&fields%5B%5D=proclamation_number&fields%5B%5D=html_url&fields%5B%5D=abstract";

export const SOURCE = "federal_register";

export interface PresidentialDoc {
  documentNumber: string;
  title: string;
  /** "Executive Order" | "Proclamation" | "Determination" */
  kind: string;
  number: string | null;
  publicationDate: string;
  signingDate: string | null;
  htmlUrl: string;
  /** Days from signing to publication, both parsed. */
  signingLagDays: number | null;
}

const str = (v: unknown): string => String(v ?? "").trim();

function daysBetween(a: string, b: string): number | null {
  const t1 = new Date(`${a}T00:00:00Z`).getTime();
  const t2 = new Date(`${b}T00:00:00Z`).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  const d = Math.round((t2 - t1) / 86_400_000);
  return d >= 0 ? d : null;
}

/**
 * Ceremonial proclamations ("Made in America Week, 2026", "Captive Nations
 * Week, 2026") are roughly half of all proclamations and carry no market
 * consequence.
 *
 * This is a SELECTION heuristic on a parsed title, not a factual claim: it
 * decides what asks for the owner's attention and never appears in a post.
 * Getting it wrong costs us a queue slot, never a false statement.
 */
export function isCeremonial(doc: PresidentialDoc): boolean {
  if (doc.kind !== "Proclamation") return false;
  return /\b(Week|Day|Month|Anniversary|Awareness)\b[^,]*,\s*\d{4}\s*$/i.test(doc.title);
}

export function parsePresidentialDocs(body: string): PresidentialDoc[] {
  const d = JSON.parse(body) as { results?: Array<Record<string, unknown>> };
  const out: PresidentialDoc[] = [];
  for (const r of d.results ?? []) {
    const documentNumber = str(r.document_number);
    const title = str(r.title);
    const publicationDate = str(r.publication_date);
    const htmlUrl = str(r.html_url);
    if (!documentNumber || !title || !publicationDate || !htmlUrl) continue;

    // subtype carries "Executive Order" / "Proclamation"; type is the generic
    // "Presidential Document".
    const kind = str(r.subtype) || str(r.type);
    const signingDate = str(r.signing_date) || null;
    const numeric = str(r.executive_order_number) || str(r.proclamation_number) || null;

    out.push({
      documentNumber,
      title,
      kind,
      number: numeric,
      publicationDate,
      signingDate,
      htmlUrl,
      signingLagDays: signingDate ? daysBetween(signingDate, publicationDate) : null,
    });
  }
  return out;
}

export function scorePresidentialDoc(doc: PresidentialDoc): number {
  if (isCeremonial(doc)) return SCORE_LOG_ONLY;
  // Executive orders and determinations are substantive by construction.
  if (doc.kind === "Executive Order" || doc.kind === "Determination") return SCORE_AUTO_ALERT;
  if (doc.kind === "Proclamation") return SCORE_POSTABLE;
  return SCORE_LOG_ONLY;
}

/** Tier A: the document's own title, kind and dates. Nothing interpreted. */
export function draftPresidentialDoc(doc: PresidentialDoc): string {
  const label = doc.number ? `${doc.kind} ${doc.number}` : doc.kind;
  const signed = doc.signingDate ? `, signed ${doc.signingDate}` : "";
  return `${label}: ${doc.title}${signed}`;
}

export async function pollFederalRegister(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, SOURCE);
  try {
    const res = await politeFetch(FEDREG_PRESIDENTIAL, {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
    });
    if (!res.ok) throw new Error(`federal register ${res.status}`);
    const docs = parsePresidentialDocs(res.body);
    if (docs.length === 0) throw new Error("parsed to zero documents");

    for (const doc of docs) {
      const score = scorePresidentialDoc(doc);
      const result = await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: doc.documentNumber,
          category: "policy",
          eventAt: `${doc.publicationDate}T00:00:00.000Z`,
          sourceUrl: doc.htmlUrl,
          payload: { ...doc, factLine: draftPresidentialDoc(doc) },
          score,
          status: score >= SCORE_POSTABLE ? "new" : "logged",
        },
        now,
      );
      if (result.outcome === "inserted" && result.id !== null && doc.signingLagDays !== null) {
        await recordFacts(
          env.DB,
          [
            {
              itemId: result.id,
              source: SOURCE,
              entity: doc.kind,
              metric: "signing_to_publication_days",
              value: doc.signingLagDays,
              occurredAt: `${doc.publicationDate}T00:00:00.000Z`,
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
    log("error", "federal register poll failed", { error: String(e), failures: state.consecutiveFailures });
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
    const result = await enqueueForApproval(env, row.id, "POLICY_ACTION", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
