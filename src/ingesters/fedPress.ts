import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAll, extractFirst, stripBom, unwrapCdata } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { isFreshAtIngest } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Fed press releases (live-verified 2026-07-26; fixture captured
// 2026-07-27T05:24Z): RSS 2.0 with UTF-8 BOM; link/guid/description/pubDate
// CDATA-wrapped, <category> plain, <title> plain; guid == URL == dedupe key;
// per-item category makes press_all.xml sufficient alone. Edge-cached
// (~5 min floor) -> every_5m cadence is honest.
export const FED_FEED = "https://www.federalreserve.gov/feeds/press_all.xml";
export const SOURCE = "fed_press";

/** Editorial grade per the Fed's own category strings (observed set). */
export const CATEGORY_SCORES: Record<string, number> = {
  "Monetary Policy": 3, // FOMC statements/minutes/discount-rate actions
  "Enforcement Actions": 2,
  "Banking and Consumer Regulatory Policy": 2,
  Orders: 1,
  "Other Announcements": 1,
};

export interface FedItem {
  title: string;
  link: string;
  guid: string;
  category: string;
  pubIso: string;
}

export function parseFedFeed(xml: string): FedItem[] {
  const out: FedItem[] = [];
  for (const item of extractAll(stripBom(xml), "item")) {
    const guid = unwrapCdata(extractFirst(item, "guid") ?? "").trim();
    if (!guid) continue;
    const pub = new Date(unwrapCdata(extractFirst(item, "pubDate") ?? "").trim());
    out.push({
      title: decodeEntities((extractFirst(item, "title") ?? "").trim()),
      link: unwrapCdata(extractFirst(item, "link") ?? "").trim(),
      guid,
      category: decodeEntities((extractFirst(item, "category") ?? "").trim()),
      pubIso: Number.isNaN(pub.getTime()) ? "" : pub.toISOString(),
    });
  }
  return out;
}

export function scoreFedItem(item: FedItem): number {
  const s = CATEGORY_SCORES[item.category];
  if (s === undefined) {
    log("warn", "unknown fed press category", { category: item.category });
    return SCORE_LOG_ONLY;
  }
  return s;
}

/** Tier A: the Fed's own headline, category-tagged. */
export function draftFed(item: FedItem): string {
  return `Fed, ${item.category}: ${item.title}`;
}

export async function pollFedPress(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);

  if (!budget.take(1)) {
    log("warn", "tick budget exhausted before fed_press poll; deferring");
    return;
  }
  let res;
  try {
    res = await politeFetch(FED_FEED, {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
      validators: { etag: state.etag, lastModified: state.lastModified },
    });
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state);
    log("warn", "fed_press fetch failed", { error: String(e), failures: state.consecutiveFailures });
    return;
  }

  try {
    if (!res.notModified) {
      if (!res.ok) {
        state.consecutiveFailures += 1;
        await putSourceState(env.DB, state);
        log("warn", "fed_press non-2xx", { status: res.status, failures: state.consecutiveFailures });
        return;
      }
      const items = parseFedFeed(res.body);
      if (items.length === 0) {
        state.consecutiveFailures += 1;
        await putSourceState(env.DB, state);
        log("warn", "fed_press parsed to zero items; possible shape drift", { bodyPrefix: res.body.slice(0, 120) });
        return;
      }
      for (const item of items) {
        const score = scoreFedItem(item);
        await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: item.guid,
            category: "fed",
            eventAt: item.pubIso || null,
            sourceUrl: item.link || item.guid,
            payload: { title: item.title, category: item.category },
            score,
            status: score >= SCORE_POSTABLE && isFreshAtIngest(item.pubIso, now) ? "new" : "logged",
          },
          now,
        );
      }
      state.etag = res.etag;
      state.lastModified = res.lastModified;
    }

    // Drain (runs on 304 ticks too).
    const pending = await env.DB.prepare(
      `SELECT id, source_url, payload FROM items
       WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 5`,
    )
      .bind(SOURCE, SCORE_POSTABLE)
      .all<{ id: number; source_url: string; payload: string }>();
    let enqueued = 0;
    for (const row of pending.results) {
      if (!budget.take(1)) break;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const result = await enqueueForApproval(env, row.id, "FED_PRESS", payload, row.source_url, now);
      enqueued += 1;
      if (result.retryAfter !== null) break;
    }

    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);
    if (enqueued > 0) log("info", "fed_press poll", { enqueued });
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    log("error", "fed_press post-fetch processing failed", { error: String(e) });
  }
}
