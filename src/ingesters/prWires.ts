import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAll, extractFirst, stripBom } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_LOG_ONLY } from "../lib/db";
import { iso } from "../lib/time";
import { log } from "../lib/log";

/**
 * PR wires (p5-21): GlobeNewswire and PR Newswire.
 *
 * THESE ITEMS NEVER BECOME A POST. That is the whole design, and it comes
 * from two rules that meet here.
 *
 * Non-negotiable #3 bans vendor-data republishing, and these are vendors. But
 * the p4 mesh rules (owner-set) already say what to do with a news item:
 *
 *   "Social and news items are DISCOVERY, never citation. A mesh item
 *    pointing at a filing or official release gets the PRIMARY document
 *    fetched, parsed, and queued with its own attribution."
 *
 * So a wire item is a SIGNAL that something happened, recorded in the lake at
 * log-only score and never enqueued. What the desk publishes is the company's
 * own filing, carded by the lane that owns it, citing the SEC. The wire tells
 * us where to look; it is never what we quote.
 *
 * That is also why there is no archetype here, no attribution entry, and no
 * template. There is nothing for them to render — by construction, not by
 * omission. A future corroboration step reads these rows; nothing else does.
 *
 * BOTH ENDPOINTS LIVE-VERIFIED 2026-08-06 from BOTH egress points
 * (docs/SOURCE_REGISTRY.md): Worker 200 `application/rss+xml` 33,546B / 95ms
 * and 200 `application/xml` 42,304B / 17ms, residential 200 for both, 20
 * parseable items each. ACCESSWIRE was probed the same day and RETIRED: two
 * documented paths, 404 and 500, from both egress points.
 */

export interface WireSource {
  readonly id: string;
  readonly wire: string;
  readonly url: string;
}

export const WIRE_SOURCES: readonly WireSource[] = [
  {
    id: "wire_globenewswire",
    wire: "GlobeNewswire",
    url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies",
  },
  {
    id: "wire_prnewswire",
    wire: "PR Newswire",
    // The financial-services path. `news-releases-list.rss` 301s and is not
    // the live feed; recorded in the registry so the redirect is not
    // rediscovered later.
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss",
  },
];

export interface WireItem {
  readonly title: string;
  readonly link: string;
  readonly guid: string;
  readonly pubDateIso: string | null;
}

/**
 * Parse an RSS 2.0 channel.
 *
 * Split on `<item>` rather than counting them, because counting is where this
 * lane already went wrong once: `grep -c "<item>"` counts matching LINES and
 * both feeds are a single line, so the count could only ever be 1 or 0 and it
 * read like a discovery about the feed's shape (D-53).
 */
export function parseWireFeed(xml: string): WireItem[] {
  const body = stripBom(xml);
  const out: WireItem[] = [];
  for (const raw of body.split("<item>").slice(1)) {
    const chunk = raw.split("</item>")[0] ?? "";
    const title = decodeEntities(extractFirst(chunk, "title") ?? "").trim();
    const link = decodeEntities(extractFirst(chunk, "link") ?? "").trim();
    if (!title || !link) continue;
    const guid = decodeEntities(extractFirst(chunk, "guid") ?? "").trim() || link;
    const pub = extractFirst(chunk, "pubDate");
    const parsed = pub ? Date.parse(decodeEntities(pub)) : NaN;
    out.push({
      title,
      link,
      guid,
      pubDateIso: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    });
  }
  return out;
}

/** Per-run insert cap. These feeds carry 20 items and refresh constantly. */
export const MAX_WIRE_ITEMS_PER_RUN = 20;

export async function pollPrWire(env: Env, source: WireSource, now: Date, budget: TickBudget): Promise<number> {
  const state = await getSourceState(env.DB, source.id);
  state.lastPolledAt = iso(now);
  if (!budget.take(1)) {
    log("warn", "tick budget exhausted before wire poll; deferring", { source: source.id });
    return 0;
  }
  try {
    const res = await politeFetch(source.url, { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000 });
    if (!res.ok) {
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
      await recordSourceError(env.DB, source.id, `${source.id} ${res.status}`, now);
      log("warn", "wire feed non-2xx", { source: source.id, status: res.status });
      return 0;
    }
    const items = parseWireFeed(res.body);
    if (items.length === 0) {
      // A 200 with no parseable items is a SHAPE CHANGE, not a quiet day.
      // Recorded as a failure so the registry notices rather than showing a
      // healthy source that has silently stopped producing.
      state.consecutiveFailures += 1;
      await putSourceState(env.DB, state);
      await recordSourceError(env.DB, source.id, `${source.id}: 200 but zero parseable items`, now);
      log("warn", "wire feed parsed to zero items; possible shape drift", { source: source.id, bytes: res.body.length });
      return 0;
    }

    let inserted = 0;
    for (const item of items.slice(0, MAX_WIRE_ITEMS_PER_RUN)) {
      const result = await insertItem(
        env.DB,
        {
          source: source.id,
          externalId: item.guid,
          category: "wire_discovery",
          eventAt: item.pubDateIso,
          sourceUrl: item.link,
          payload: { wire: source.wire, title: item.title, link: item.link, pubDateIso: item.pubDateIso },
          // LOG-ONLY, ALWAYS. There is no branch that raises this, and that is
          // the point: a vendor wire item is discovery and can never card.
          score: SCORE_LOG_ONLY,
          status: "logged",
        },
        now,
      );
      if (result.outcome === "inserted") inserted += 1;
    }

    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);
    if (inserted > 0) log("info", "wire discovery", { source: source.id, inserted, seen: items.length });
    return inserted;
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    await recordSourceError(env.DB, source.id, e, now).catch(() => {});
    log("error", "wire poll failed", { source: source.id, error: String(e) });
    return 0;
  }
}

export function prWireJob(source: WireSource) {
  return (env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> =>
    pollPrWire(env, source, now, budget).then(() => undefined);
}
