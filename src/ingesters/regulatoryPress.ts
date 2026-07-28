import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAll, extractFirst, stripBom } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE ,
  recordSourceError,
} from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { isFreshAtIngest } from "./shared";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// Regulator press releases, as a declarative family. These feeds carry NO
// parsed numbers — only a headline, a date and a link — so posts are
// headline + attribution + source and nothing more. persona.md allows that;
// it just means the templates here are numberless BY CONSTRUCTION and
// physically cannot emit a figure, which is the rule the roadmap asked for
// on prose-only sources.
//
// Both endpoints live-verified 2026-07-28T02:32Z.

export interface PressSource {
  id: string;
  authority: string;
  attribution: string;
  url: string;
  /** RSS <category> values worth the owner's attention. Empty = accept all. */
  categories: readonly string[];
  /** Titles matching this are routine digests, not news. */
  skipTitle?: RegExp;
}

export const PRESS_SOURCES: readonly PressSource[] = [
  {
    id: "press_fca",
    authority: "UK FCA",
    attribution: "per UK FCA",
    url: "https://www.fca.org.uk/news/rss.xml",
    // The feed mixes enforcement with blogs and speeches. Verified live
    // taxonomy: Press Releases, News stories, Blogs, Statements, Speeches.
    categories: ["Press Releases", "Statements"],
  },
  {
    id: "press_eu_commission",
    authority: "European Commission",
    attribution: "per European Commission",
    url: "https://ec.europa.eu/commission/presscorner/api/rss?language=en&pagesize=20",
    categories: [],
    // "Daily News 27 / 07 / 2026" is a roundup of everything, published every
    // weekday. It is a digest, not an event, and would crowd the queue daily.
    skipTitle: /^Daily News\b/i,
  },
];

export interface PressItem {
  title: string;
  link: string;
  publishedIso: string;
  categories: string[];
  guid: string;
}

function parseDate(v: string): string {
  // Feeds here use RFC-822 ("Mon, 27 Jul 2026 09:20:41 GMT") and a
  // human format ("Monday, July 27, 2026 - 15:30"). Date handles both;
  // anything it cannot read is dropped rather than guessed.
  const d = new Date(v.replace(/\s+-\s+/, " "));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function parsePressFeed(xml: string): PressItem[] {
  const out: PressItem[] = [];
  for (const item of extractAll(stripBom(xml), "item")) {
    const rawTitle = extractFirst(item, "title") ?? "";
    const title = decodeEntities(rawTitle.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim());
    const link = (extractFirst(item, "link") ?? "").trim();
    const published = parseDate((extractFirst(item, "pubDate") ?? "").trim());
    if (!title || !link || !published) continue;
    out.push({
      title,
      link,
      publishedIso: published,
      categories: extractAll(item, "category").map((c) => decodeEntities(c.trim())).filter(Boolean),
      guid: (extractFirst(item, "guid") ?? link).trim(),
    });
  }
  return out;
}

/** SELECTION, not a claim: decides what asks for attention, never post text. */
export function isNewsworthy(src: PressSource, item: PressItem): boolean {
  if (src.skipTitle?.test(item.title)) return false;
  if (src.categories.length === 0) return true;
  return item.categories.some((c) => src.categories.includes(c));
}

export function draftPress(src: PressSource, item: PressItem): string {
  return `${src.authority}: ${item.title}`;
}

export function makePressHandler(src: PressSource) {
  return async function pollPress(
    env: Env,
    now: Date = new Date(),
    budget: TickBudget = newTickBudget(),
  ): Promise<void> {
    if (!budget.take(1)) return;
    const state = await getSourceState(env.DB, src.id);
    try {
      const res = await politeFetch(src.url, { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`${src.id} ${res.status}`);
      const items = parsePressFeed(res.body);
      if (items.length === 0) throw new Error("parsed to zero items");

      for (const item of items) {
        const newsworthy = isNewsworthy(src, item);
        const fresh = isFreshAtIngest(item.publishedIso, now);
        const score = newsworthy ? SCORE_POSTABLE : SCORE_LOG_ONLY;
        await insertItem(
          env.DB,
          {
            source: src.id,
            externalId: item.guid,
            category: "regulatory",
            eventAt: item.publishedIso,
            sourceUrl: item.link,
            payload: {
              authority: src.authority,
              title: item.title,
              categories: item.categories,
              publishedIso: item.publishedIso,
              factLine: draftPress(src, item),
            },
            score,
            status: score >= SCORE_POSTABLE && fresh ? "new" : "logged",
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
      await recordSourceError(env.DB, src.id, e, now);
      log("error", "regulatory press poll failed", { source: src.id, error: String(e) });
      return;
    }

    const pending = await env.DB.prepare(
      `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 2`,
    )
      .bind(src.id, SCORE_POSTABLE)
      .all<{ id: number; source_url: string; payload: string }>();
    for (const row of pending.results) {
      if (!budget.take(1)) break;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const result = await enqueueForApproval(env, row.id, "REGULATORY_NEWS", payload, row.source_url, now);
      if (result.retryAfter !== null) break;
    }
  };
}
