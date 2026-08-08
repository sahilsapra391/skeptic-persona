import type { Env } from "../env";
import { fetchPool, newTickBudget, SEC_POOL_CONCURRENCY, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAllNs, extractAttr, extractFirst, extractFirstNs, stripBom } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { isFreshAtIngest } from "./shared";
import { resolveSymbol } from "../lib/symbol";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// SEC Form 25 / 25-NSE — notification of removal from listing.
//
// This CLOSES a story we already half-tell: 8-K Item 3.01 is the delisting
// NOTICE ("Delisting notice, not a delisting", per the beat library), and
// Form 25 is the exchange actually striking the security. Same issuer, weeks
// apart, and the pair is the kind of adjacency the persona doc's craft
// principle is built for.
//
// Live-verified 2026-07-28T04:18Z: feed 200 with 14 entries; the document is
// a ~1.1 KB fully typed XML with no prose anywhere.
const FEED_BASE =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&company=&dateb=&owner=include&output=atom&count=40";
export const FORM25_FEED = `${FEED_BASE}&type=25-NSE`;

export const SOURCE = "sec_form25";
export const DETAIL_BATCH_PER_RUN = 8;
export const MAX_DETAIL_ATTEMPTS = 3;

export interface Form25Entry {
  accession: string;
  dirUrl: string;
  indexUrl: string;
  filedIso: string;
}

const ACCESSION_RE = /accession-number=([0-9-]+)/;

/** Same duplicate-per-accession quirk as every other EDGAR feed: the filing
 *  appears under the exchange ("Filed by") and the issuer ("Subject"). */
export function parseForm25Feed(xml: string): Form25Entry[] {
  const out: Form25Entry[] = [];
  const seen = new Set<string>();
  for (const entry of extractAllNs(stripBom(xml), "entry")) {
    const accession = ACCESSION_RE.exec(extractFirst(entry, "id") ?? "")?.[1];
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    const indexUrl = extractAttr(entry, "link", "href") ?? "";
    if (!indexUrl) continue;
    const updated = extractFirst(entry, "updated") ?? "";
    const filedAt = new Date(updated);
    out.push({
      accession,
      indexUrl,
      dirUrl: indexUrl.replace(/\/[^/]*$/, ""),
      filedIso: Number.isNaN(filedAt.getTime()) ? "" : filedAt.toISOString(),
    });
  }
  return out;
}

export interface Form25Doc {
  exchange: string;
  issuerName: string;
  issuerCik: string;
  securityClass: string | null;
  /** The CFR cite that says WHY, in the regulation's own terms. */
  ruleProvision: string | null;
  signatureDate: string | null;
}

export function parseForm25Xml(xml: string): Form25Doc | null {
  const clean = stripBom(xml);
  const exchangeBlock = extractFirstNs(clean, "exchange") ?? "";
  const issuerBlock = extractFirstNs(clean, "issuer") ?? "";
  const exchange = decodeEntities((extractFirstNs(exchangeBlock, "entityName") ?? "").trim());
  const issuerName = decodeEntities((extractFirstNs(issuerBlock, "entityName") ?? "").trim());
  const issuerCik = (extractFirstNs(issuerBlock, "cik") ?? "").trim();
  // Without the exchange and the issuer there is no story to tell.
  if (!exchange || !issuerName || !issuerCik) return null;

  const sig = extractFirstNs(clean, "signatureData") ?? "";
  return {
    exchange,
    issuerName,
    issuerCik,
    securityClass: decodeEntities((extractFirstNs(clean, "descriptionClassSecurity") ?? "").trim()) || null,
    ruleProvision: (extractFirstNs(clean, "ruleProvision") ?? "").trim() || null,
    signatureDate: (extractFirstNs(sig, "signatureDate") ?? "").trim() || null,
  };
}

/**
 * Rule provisions worth surfacing. These are the CFR cites for an EXCHANGE
 * striking a security, as opposed to an issuer voluntarily withdrawing.
 * 12d2-2(a) is the exchange acting; 12d2-2(c) is the issuer's own request.
 */
export function isExchangeInitiated(doc: Form25Doc): boolean {
  return /12d2-2\(a\)/.test(doc.ruleProvision ?? "");
}

export function scoreForm25(doc: Form25Doc): number {
  if (!doc.ruleProvision) return SCORE_LOG_ONLY;
  // A voluntary withdrawal is routine housekeeping; the exchange removing a
  // security against the issuer is the news.
  return isExchangeInitiated(doc) ? SCORE_POSTABLE : SCORE_LOG_ONLY;
}

export function draftForm25(doc: Form25Doc, issuerLabel?: string): string {
  const cls = doc.securityClass ? ` (${doc.securityClass})` : "";
  const when = doc.signatureDate ? `, filed ${doc.signatureDate}` : "";
  return `${doc.exchange} filed to remove ${issuerLabel && issuerLabel.trim() !== "" ? issuerLabel : doc.issuerName}${cls} from listing${when}`;
}

export async function pollForm25(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);
  const state = await getSourceState(env.DB, SOURCE);

  if (budget.take(1)) {
    try {
      const res = await politeFetch(FORM25_FEED, { userAgent, timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`form25 feed ${res.status}`);
      const entries = parseForm25Feed(res.body);
      if (entries.length === 0) throw new Error("feed parsed to zero entries");

      for (const e of entries) {
        await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: e.accession,
            category: "delisting",
            eventAt: e.filedIso || null,
            sourceUrl: e.indexUrl,
            payload: { phase: "stub", dirUrl: e.dirUrl, accession: e.accession },
            score: SCORE_LOG_ONLY,
            // The feed carries no rule provision, so nothing is postable
            // until the document says who initiated the removal.
            status: isFreshAtIngest(e.filedIso, now) ? "pending_detail" : "logged",
          },
          now,
        );
      }
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
    } catch (e) {
      state.consecutiveFailures += 1;
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
      await recordSourceError(env.DB, SOURCE, e, now);
      log("error", "form25 feed failed", { error: String(e) });
    }
  }

  const pending = await env.DB.prepare(
    `SELECT id, payload, event_at FROM items WHERE source = ?1 AND status = 'pending_detail' ORDER BY id LIMIT ?2`,
  )
    .bind(SOURCE, DETAIL_BATCH_PER_RUN)
    .all<{ id: number; payload: string; event_at: string | null }>();

  const affordable = pending.results.filter(() => budget.take(1));
  if (affordable.length > 0) {
    await fetchPool(
    affordable,
    async (row) => {
      let attempts = 0;
      try {
        const stub = JSON.parse(row.payload) as { dirUrl: string; accession: string; attempts?: number };
        attempts = stub.attempts ?? 0;
        const res = await politeFetch(`${stub.dirUrl}/primary_doc.xml`, { userAgent, timeoutMs: 20_000 });
        if (!res.ok) throw new Error(`primary_doc ${res.status}`);
        const doc = parseForm25Xml(res.body);
        if (!doc) throw new Error("primary_doc did not parse");

        const score = scoreForm25(doc);
        // A2/B-21.1: DELISTING carried no cashtag either.
        const symbol = await resolveSymbol(env, { cik: doc.issuerCik, issuerName: doc.issuerName });
        const fresh = isFreshAtIngest(row.event_at ?? "", now);
        await env.DB.prepare(
          `UPDATE items SET payload = ?1, score = ?2, status = ?3 WHERE id = ?4 AND status = 'pending_detail'`,
        )
          .bind(
            JSON.stringify({
              phase: "detail",
              ...doc,
              exchangeInitiated: isExchangeInitiated(doc),
              factLine: draftForm25(doc, symbol.label),
              issuerLabel: symbol.label,
              ticker: symbol.ticker,
              tickerSource: symbol.source,
            }),
            score,
            score >= SCORE_POSTABLE && fresh ? "new" : "logged",
            row.id,
          )
          .run();
      } catch (err) {
        const next = attempts + 1;
        const giveUp = next >= MAX_DETAIL_ATTEMPTS;
        log(giveUp ? "warn" : "info", "form25 detail failed", { itemId: row.id, attempt: next, error: String(err) });
        await env.DB.prepare(
          `UPDATE items SET payload = json_set(payload, '$.attempts', ?1), status = ?2
           WHERE id = ?3 AND status = 'pending_detail'`,
        )
          .bind(next, giveUp ? "logged" : "pending_detail", row.id)
          .run()
          .catch(() => {});
      }
      },
      // Nested inside the dispatcher's job pool: see SEC_POOL_CONCURRENCY.
      SEC_POOL_CONCURRENCY,
    );
  }

  const drain = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 3`,
  )
    .bind(SOURCE, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  for (const row of drain.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "DELISTING", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
