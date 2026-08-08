import type { Env } from "../env";
import { gateContext, issuerGate } from "./issuers";
import { fetchPool, newTickBudget, SEC_POOL_CONCURRENCY, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAllNs, extractAttr, extractFirst, extractFirstNs, stripBom } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { fmtNum, fmtUsd, isFreshAtIngest } from "./shared";
import { deriveDisplayName } from "../lib/names";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// SEC Form 144 — NOTICE OF PROPOSED SALE. Live-verified 2026-07-27T20:35Z:
// feed 200/6060 bytes/10 entries; documents 200 (fixtures captured).
//
// Why this source matters more than its size suggests: it is the only feed in
// the pipeline that reports an insider sale BEFORE it happens. The Form 4 we
// already ingest is the confirmation, filed days later. Pairing them yields
// the filed-to-executed lag, which nobody else publishes.
const FEED_BASE =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=144&company=&dateb=&owner=include&output=atom";
export const FORM144_FEED = `${FEED_BASE}&count=100`;

export const SOURCE = "sec_form144";

/** Editorial grades. Only parsed dollars decide; nothing is inferred. */
export const NOTICE_POSTABLE_USD = 1_000_000;
export const NOTICE_ALERT_USD = 25_000_000;
/** A sale worth this share of shares outstanding is notable regardless of size. */
export const NOTICE_ALERT_PCT_OUTSTANDING = 1;

export const DETAIL_BATCH_PER_RUN = 10;
/** Matches Form 4: a transient SEC failure must not discard a filing. */
export const MAX_DETAIL_ATTEMPTS = 3;
export const MAX_ENQUEUES_PER_RUN = 5;

// ---------------------------------------------------------------------------
// Feed

export interface Form144FeedEntry {
  accession: string;
  dirUrl: string;
  indexUrl: string;
  filedIso: string;
  /** EDGAR's CONFORMED name for the reporting person, from the `(Reporting)`
   *  entry title. Null when the feed carried no such entry. This, and never
   *  the document's free-text seller field, is what a reorder may use. */
  conformedSeller: string | null;
}

const ACCESSION_RE = /accession-number=([0-9-]+)/;

/**
 * VERIFIED QUIRK (same shape as Form 4): one filing appears TWICE per page,
 * once under the seller CIK ("(Reporting)") and once under the issuer CIK
 * ("(Subject)"), with the SAME accession in <id>. Dedup on accession or every
 * notice posts twice.
 */
/** `144 - MILLER KENDRA D (0001514725) (Reporting)`. The trailing role tag is
 *  what separates the seller from the issuer, and both share an accession. */
const TITLE_RE = /^\s*[^-]*-\s*(.+?)\s*\(\d{7,10}\)\s*\((Reporting|Subject)\)\s*$/;

export function parseForm144Feed(xml: string): Form144FeedEntry[] {
  const out: Form144FeedEntry[] = [];
  const byAccession = new Map<string, Form144FeedEntry>();
  for (const entry of extractAllNs(stripBom(xml), "entry")) {
    const accession = ACCESSION_RE.exec(extractFirst(entry, "id") ?? "")?.[1];
    if (!accession) continue;

    // THE CONFORMED SELLER NAME (B-12.3). A filing appears twice, once under
    // the seller CIK and once under the issuer's, and which one comes FIRST
    // varies. Taking the first title would have stamped the issuer's name on
    // half the notices, so the `(Reporting)` tag is matched explicitly and the
    // other entry only contributes its accession.
    const title = decodeEntities((extractFirst(entry, "title") ?? "").trim());
    const m = TITLE_RE.exec(title);
    const conformed = m && m[2] === "Reporting" ? (m[1] ?? "").trim() || null : null;

    const existing = byAccession.get(accession);
    if (existing) {
      if (existing.conformedSeller === null && conformed !== null) existing.conformedSeller = conformed;
      continue;
    }

    const indexUrl = extractAttr(entry, "link", "href") ?? "";
    if (!indexUrl) continue;
    const updated = extractFirst(entry, "updated") ?? "";
    const filedAt = new Date(updated);

    const row: Form144FeedEntry = {
      accession,
      indexUrl,
      dirUrl: indexUrl.replace(/\/[^/]*$/, ""),
      filedIso: Number.isNaN(filedAt.getTime()) ? "" : filedAt.toISOString(),
      conformedSeller: conformed,
    };
    byAccession.set(accession, row);
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document
//
// NAMESPACE TRAP (verified with two live filings on the same day): filing
// agents disagree on prefixes. Accession 0001628280-26-049826 (Workiva) writes
// <own:issuerName>; 0000764900-26-000029 writes <issuerName>. Every read here
// goes through the namespace-agnostic helpers — a prefix-specific parser
// returns nothing for half of all filings, silently.

export interface Form144Acquisition {
  acquiredDate: string | null;
  nature: string | null;
  isGift: boolean;
  amount: number | null;
}

export interface Form144Doc {
  issuerCik: string;
  issuerName: string;
  sellerName: string;
  relationships: string[];
  securitiesClass: string | null;
  broker: string | null;
  unitsSold: number | null;
  aggregateMarketValue: number | null;
  unitsOutstanding: number | null;
  approxSaleDate: string | null; // MM/DD/YYYY as filed
  approxSaleIso: string | null; // normalized
  exchange: string | null;
  acquisitions: Form144Acquisition[];
  /** Share of shares outstanding, computed from two parsed fields only. */
  pctOfOutstanding: number | null;
}

function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number.parseFloat(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** MM/DD/YYYY (as filed) -> ISO date. Returns null on anything else. */
export function usDateToIso(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const [, mo, d, y] = m;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // Round-trip: Date happily rolls 02/30 forward to March, so compare the
  // parsed components back rather than trusting non-NaN.
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() + 1 !== Number(mo) || dt.getUTCDate() !== Number(d)) {
    return null;
  }
  return iso;
}

export function parseForm144Xml(xml: string): Form144Doc | null {
  const clean = stripBom(xml);
  // Both conventions declare the ownership namespace; the tag test must be
  // prefix-agnostic too.
  if (extractFirstNs(clean, "formData") === null) return null;

  const issuerCik = (extractFirstNs(clean, "issuerCik") ?? "").trim();
  const issuerName = decodeEntities((extractFirstNs(clean, "issuerName") ?? "").trim());
  const sellerName = decodeEntities(
    (extractFirstNs(clean, "nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold") ?? "").trim(),
  );
  if (!issuerCik || !issuerName || !sellerName) return null;

  const relBlock = extractFirstNs(clean, "relationshipsToIssuer") ?? "";
  const relationships = extractAllNs(relBlock, "relationshipToIssuer")
    .map((r) => decodeEntities(r.trim()))
    .filter((r) => r !== "");

  const secInfo = extractFirstNs(clean, "securitiesInformation") ?? "";
  const brokerBlock = extractFirstNs(secInfo, "brokerOrMarketmakerDetails") ?? "";
  const unitsSold = num(extractFirstNs(secInfo, "noOfUnitsSold"));
  const unitsOutstanding = num(extractFirstNs(secInfo, "noOfUnitsOutstanding"));
  const approxSaleDate = (extractFirstNs(secInfo, "approxSaleDate") ?? "").trim() || null;

  const acquisitions: Form144Acquisition[] = extractAllNs(clean, "securitiesToBeSold").map((b) => ({
    acquiredDate: (extractFirstNs(b, "acquiredDate") ?? "").trim() || null,
    nature: decodeEntities((extractFirstNs(b, "natureOfAcquisitionTransaction") ?? "").trim()) || null,
    isGift: (extractFirstNs(b, "isGiftTransaction") ?? "").trim().toUpperCase() === "Y",
    amount: num(extractFirstNs(b, "amountOfSecuritiesAcquired")),
  }));

  // Derived from two parsed fields, nothing else. Null when either is absent.
  // A notice cannot sell more of a class than exists, so a ratio above 100%
  // means a field is garbage — treat that as a parse failure rather than
  // publishing "10,000,000% of shares outstanding" and auto-alerting on it.
  let pctOfOutstanding: number | null = null;
  if (unitsSold !== null && unitsOutstanding !== null && unitsOutstanding > 0 && unitsSold <= unitsOutstanding) {
    pctOfOutstanding = Math.round((unitsSold / unitsOutstanding) * 10000) / 100;
  }

  return {
    issuerCik,
    issuerName,
    sellerName,
    relationships,
    securitiesClass: decodeEntities((extractFirstNs(secInfo, "securitiesClassTitle") ?? "").trim()) || null,
    broker: decodeEntities((extractFirstNs(brokerBlock, "name") ?? "").trim()) || null,
    unitsSold,
    aggregateMarketValue: num(extractFirstNs(secInfo, "aggregateMarketValue")),
    unitsOutstanding,
    approxSaleDate,
    approxSaleIso: usDateToIso(approxSaleDate),
    exchange: decodeEntities((extractFirstNs(secInfo, "securitiesExchangeName") ?? "").trim()) || null,
    acquisitions,
    pctOfOutstanding,
  };
}

// ---------------------------------------------------------------------------
// Scoring + fact line

export function scoreForm144(doc: Form144Doc): number {
  const value = doc.aggregateMarketValue;
  // A notice whose value did not parse can never be claimed in a post.
  if (value === null) return SCORE_LOG_ONLY;
  if (value >= NOTICE_ALERT_USD) return SCORE_AUTO_ALERT;
  if (doc.pctOfOutstanding !== null && doc.pctOfOutstanding >= NOTICE_ALERT_PCT_OUTSTANDING) {
    return SCORE_AUTO_ALERT;
  }
  if (value >= NOTICE_POSTABLE_USD) return SCORE_POSTABLE;
  return SCORE_LOG_ONLY;
}

/** Relationship label, verbatim from the filing (values vary: "Officer",
 *  "Director", "10% Owner", "Member of 10% Owner"). Never normalized. */
export function relationshipLabel(doc: Form144Doc): string | null {
  return doc.relationships.length > 0 ? doc.relationships.join(", ") : null;
}

/**
 * p6-01 (A1). Form 144's `nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold`
 * carries the same `LAST FIRST MIDDLE` convention as Form 4's `rptOwnerName`
 * (live-verified 2026-08-07: "Hermance David F.", "Hakim Anat").
 *
 * The relationship strings are the natural-person signal the reorder needs. A
 * notice filed by an entity is usually marked "10% Owner" alone, so only an
 * officer or director releases a flip on a bare two-token name.
 */
export function sellerDisplayName(doc: Form144Doc, conformedSeller?: string | null): string {
  const rels = doc.relationships.map((r) => r.toLowerCase());
  const opts = {
    isOfficer: rels.some((r) => r.includes("officer")),
    isDirector: rels.some((r) => r.includes("director")),
  };
  // THE FREE-TEXT FIELD IS NEVER REORDERED (B-12.3).
  // `nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold` is typed by the
  // filer agent and disagreed with EDGAR's conformed name in 25 of 87
  // comparable filings on 2026-08-07. Reordering it produced `D. Miller
  // Kendra` for a person the Form 4 lane rendered `Kendra D. Miller` the same
  // day, from the same CIK. The conformed name from the feed is the only
  // licensed reorder input; without it the document text is merely cased.
  if (conformedSeller && conformedSeller.trim() !== "") {
    return deriveDisplayName(conformedSeller, { ...opts, conformed: true }).display;
  }
  return deriveDisplayName(doc.sellerName, opts).display;
}

/** Tier A fact line: parsed fields and arithmetic over them, nothing more. */
export function draftForm144(doc: Form144Doc, conformedSeller?: string | null): string {
  const rel = relationshipLabel(doc);
  // p6-01 (A1): the DISPLAY form, because EDGAR files `LAST FIRST MIDDLE` and
  // "Sheena Jonathan" shipped on card #1232. The filed string stays on the
  // payload as `sellerNameFiled` for validation and audit.
  const who = `${sellerDisplayName(doc, conformedSeller)}${rel ? ` (${rel})` : ""}`;
  // NOT a ticker: Form 144 parses no trading symbol at all, only the issuer
  // name. Named honestly so nobody later 'fixes' this into $Company Inc.
  const issuer = doc.issuerName;
  const parts: string[] = [];
  if (doc.unitsSold !== null) parts.push(`${fmtNum(doc.unitsSold)} shares`);
  if (doc.aggregateMarketValue !== null) parts.push(`${fmtUsd(doc.aggregateMarketValue)}`);
  const size = parts.length > 0 ? ` ${parts.join(", ")}` : "";
  const when = doc.approxSaleDate ? ` on or after ${doc.approxSaleDate}` : "";
  // NOT "to sell": persona section 6 bans buy/sell as advice tokens, and the
  // poster's register guard blocks the word outright — every draft would be
  // rejected at the last gate. "Proposed sale" is also the form's own term.
  // No "Form 144:" prefix either: the renderer appends the attribution, and
  // naming the form twice in one line reads as a template seam.
  return `${who} filed notice of a proposed sale${size ? ` of${size}` : ""} of ${issuer}${when}`;
}

// ---------------------------------------------------------------------------
// Poll

export async function pollForm144(env: Env, now: Date = new Date(), budget: TickBudget = newTickBudget()): Promise<void> {
  const userAgent = buildUserAgent(env.CONTACT_EMAIL);
  const state = await getSourceState(env.DB, SOURCE);

  if (budget.take(1)) {
    try {
      const res = await politeFetch(FORM144_FEED, { userAgent, timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const entries = parseForm144Feed(res.body);
      if (entries.length === 0) throw new Error("feed parsed to zero entries");

      let stubs = 0;
      for (const e of entries) {
        // Stub first, detail second: the feed carries no numbers at all, so
        // nothing here is postable until the document is parsed.
        const result = await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: e.accession,
            category: "insider_notice",
            eventAt: e.filedIso || null,
            sourceUrl: e.indexUrl,
            payload: { phase: "stub", dirUrl: e.dirUrl, accession: e.accession, conformedSeller: e.conformedSeller },
            score: SCORE_LOG_ONLY,
            status: isFreshAtIngest(e.filedIso, now) ? "pending_detail" : "logged",
          },
          now,
        );
        if (result.outcome === "inserted") stubs += 1;
      }
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
      if (stubs > 0) log("info", "form 144 stubs ingested", { stubs });
    } catch (e) {
      state.consecutiveFailures += 1;
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
      log("error", "form 144 feed failed", { error: String(e), consecutiveFailures: state.consecutiveFailures });
    }
  }

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

  // One fetch per filing, run through the bounded pool: the platform allows
  // only 6 concurrent outbound connections, and SEC asks for <=10 req/s.
  const affordable = pending.results.filter(() => budget.take(1));
  if (affordable.length === 0) return;

  await fetchPool(
    affordable,
    async (row) => {
    // Everything inside the try: a malformed payload row must not reject the
    // pool and take the whole poll down with it.
    let attempts = 0;
    try {
      const stub = JSON.parse(row.payload) as {
        dirUrl: string;
        accession: string;
        attempts?: number;
        conformedSeller?: string | null;
      };
      attempts = stub.attempts ?? 0;
      const res = await politeFetch(`${stub.dirUrl}/primary_doc.xml`, { userAgent, timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`primary_doc ${res.status}`);
      const doc = parseForm144Xml(res.body);
      if (!doc) throw new Error("primary_doc did not parse");

      let score = scoreForm144(doc);
      // ISSUER GATE. Same reference the 8-K lane uses, same fail-open rules.
      // The filing still lands in the lake; it just stops interrupting.
      const gate = await issuerGate(env, doc.issuerCik, ctx);
      if (!gate.keep) {
        score = Math.min(score, SCORE_LOG_ONLY);
        log("debug", "form144 suppressed by issuer gate", { cik: doc.issuerCik, reason: gate.reason });
      }
      const fresh = isFreshAtIngest(row.event_at ?? "", now);
      await env.DB.prepare(
        `UPDATE items SET payload = ?1, score = ?2, status = ?3 WHERE id = ?4 AND status = 'pending_detail'`,
      )
        .bind(
          JSON.stringify({
            phase: "detail",
            accession: stub.accession,
            issuerCik: doc.issuerCik,
            issuerName: doc.issuerName,
            // p6-01: `sellerName` is what every template, beat and prompt
            // prints, so it carries the DISPLAY form. The filed string keeps
            // its own key so validation and audit still see the record.
            sellerName: sellerDisplayName(doc, stub.conformedSeller),
            sellerNameFiled: doc.sellerName,
            sellerNameConformed: stub.conformedSeller ?? null,
            relationships: doc.relationships,
            relationshipLabel: relationshipLabel(doc),
            securitiesClass: doc.securitiesClass,
            broker: doc.broker,
            unitsSold: doc.unitsSold,
            aggregateMarketValue: doc.aggregateMarketValue,
            unitsOutstanding: doc.unitsOutstanding,
            approxSaleDate: doc.approxSaleDate,
            approxSaleIso: doc.approxSaleIso,
            exchange: doc.exchange,
            pctOfOutstanding: doc.pctOfOutstanding,
            isGift: doc.acquisitions.some((a) => a.isGift),
            acquisitionNature: doc.acquisitions[0]?.nature ?? null,
            // Derived at PARSE time from the filing's own nature text, so the
            // beat gates on a boolean field rather than re-reading prose.
            // SHARE-WEIGHTED, not some(): a multi-lot notice where 10 of
            // 100,010 shares came from an exercise must not claim the sale
            // was an exercise. True only when every lot that parsed a nature
            // says exercise.
            acquisitionIsExercise: (() => {
              const withNature = doc.acquisitions.filter((a) => a.nature !== null);
              return withNature.length > 0 && withNature.every((a) => /exercise/i.test(a.nature ?? ""));
            })(),
            factLine: draftForm144(doc, stub.conformedSeller),
          }),
          score,
          score >= SCORE_POSTABLE && fresh ? "new" : "logged",
          row.id,
        )
        .run();
    } catch (e) {
      // RETRY like Form 4: SEC Archives 403s bursts, and this poll now fires
      // 6 concurrent document GETs from a shared Cloudflare egress IP. One
      // transient 503 must not lose a filing forever.
      const next = attempts + 1;
      const giveUp = next >= MAX_DETAIL_ATTEMPTS;
      log(giveUp ? "warn" : "info", "form 144 detail failed", {
        itemId: row.id,
        attempt: next,
        giveUp,
        error: String(e),
      });
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

async function drainPostables(env: Env, now: Date, budget: TickBudget): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items
     WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT ?3`,
  )
    .bind(SOURCE, SCORE_POSTABLE, MAX_ENQUEUES_PER_RUN)
    .all<{ id: number; source_url: string; payload: string }>();

  // Space the sends: Telegram allows ~1 message/sec per chat, and
  // enqueueForApproval creates the queue row BEFORE notifying — a flood-
  // controlled item would be marked 'queued', never re-selected by this
  // drain, and expire without the owner ever seeing it.
  let sent = 0;
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "INSIDER_NOTICE", payload, row.source_url, now);
    sent += 1;
    if (result.retryAfter !== null) break;
    // Pacing moved to sendMessage (per-CHAT, not per-job). A sleep here paced
    // this loop against itself; with concurrent jobs nothing paced the chat.
  }
}
