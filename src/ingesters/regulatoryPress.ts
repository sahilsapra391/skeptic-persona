import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { decodeEntities, extractAll, extractFirst, stripBom } from "../lib/xml";
import { htmlToText, scrubUrls } from "../lib/html";
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
  url: string;
  /** RSS <category> values worth the owner's attention. Empty = accept all. */
  categories: readonly string[];
  /** Titles matching this are routine digests, not news. */
  skipTitle?: RegExp;
}

/**
 * gov.uk serves one Atom feed per organisation, mixing press releases with
 * every document that organisation publishes. Documents carry a type prefix
 * ("Transparency data: CMA: spending over £500") and press releases do not,
 * so the prefix is the whole filter: keep the unprefixed items, drop the
 * document library.
 *
 * The list is explicit rather than a `/^[A-Z][a-z ]+:/` shape, because a real
 * headline can lead with a colon too ("Vodafone: CMA opens inquiry") and that
 * one must survive.
 */
const GOV_UK_DOCUMENT_PREFIX =
  /^(transparency data|corporate report|foi release|guidance|statutory guidance|correspondence|policy paper|research and analysis|impact assessment|consultation outcome|open consultation|closed consultation|independent report|promotional material|form|notice|accredited official statistics|official statistics|national statistics|statistical data set):/i;

export const PRESS_SOURCES: readonly PressSource[] = [
  // --- Enforcement wire. Highest-lift category measured across the five
  // competitor corpora (1.63x median engagement), and these are the actions
  // themselves rather than anyone's report of them.
  {
    id: "press_sec_enforcement",
    authority: "SEC",
    // Administrative proceedings. NOTE: the litigation-releases feed at
    // /rss/litigation/litreleases.xml is DEAD (404, serves an HTML page).
    url: "https://www.sec.gov/rss/litigation/admin.xml",
    categories: [],
  },
  {
    id: "press_cftc_enforcement",
    authority: "CFTC",
    // PARKED 2026-07-28: this host 403s Cloudflare Worker egress while
    // returning 200 to the same declared UA from a residential connection.
    // SEC and FTC were polled in the same tick and both succeeded, so the
    // block is host-specific. Left registered on a daily probe so it
    // self-recovers if the block lifts. CFTC *positioning* is unaffected —
    // that is publicreporting.cftc.gov, a different host.
    url: "https://www.cftc.gov/RSS/RSSENF/rssenf.xml",
    categories: [],
  },
  {
    id: "press_ftc_competition",
    authority: "FTC",
    url: "https://www.ftc.gov/feeds/press-release-competition.xml",
    categories: [],
  },
  {
    id: "press_boj",
    authority: "Bank of Japan",
    // English "What's New". Verified 2026-07-28: 39 items, JST offsets
    // (+0900) — a FIFTH timestamp convention in this pipeline.
    url: "https://www.boj.or.jp/en/rss/whatsnew.xml",
    categories: [],
    // The feed mixes policy with conference notices and research bulletins.
    // Those are not market events and would take a queue slot each.
    skipTitle: /^\(IMES|Newsletter|Conference|Speech at|Opening Remarks/i,
  },
  {
    id: "press_fca",
    authority: "UK FCA",
    url: "https://www.fca.org.uk/news/rss.xml",
    // The feed mixes enforcement with blogs and speeches. Verified live
    // taxonomy: Press Releases, News stories, Blogs, Statements, Speeches.
    categories: ["Press Releases", "Statements"],
  },
  {
    id: "press_eu_commission",
    authority: "European Commission",
    url: "https://ec.europa.eu/commission/presscorner/api/rss?language=en&pagesize=20",
    categories: [],
    // "Daily News 27 / 07 / 2026" is a roundup of everything, published every
    // weekday. It is a digest, not an event, and would crowd the queue daily.
    skipTitle: /^Daily News\b/i,
  },
  // --- GLOBAL WIRE FANOUT, batch 1 (p4-11). Every URL below was live-probed
  // 2026-08-01T22:4xZ with a declared UA and kept only if it returned 200
  // AND parsed to three or more items. Eleven other candidates failed and
  // are recorded in the verification doc rather than left as folklore.
  {
    id: "press_doj",
    authority: "DOJ",
    url: "https://www.justice.gov/news/rss?type=press_release",
    categories: [],
    // DOJ publishes the whole department. Nominations, grants, community
    // programmes and appointments are not market intelligence.
    // \w* on the stems, not a bare \b: "nominat\b" cannot match "Nominates",
    // because the boundary it demands falls in the middle of the word.
    skipTitle: /\b(nominat\w*|grant award|communit\w*|appoint\w*|swearing|memorial|award ceremony)\b/i,
  },
  {
    id: "press_fed_speeches",
    authority: "Federal Reserve",
    // Speeches, distinct from press_all: this is where policy is signalled
    // between meetings, and the FOMC statement itself already arrives via
    // fed_press.
    url: "https://www.federalreserve.gov/feeds/speeches.xml",
    categories: [],
  },
  {
    id: "press_ecb",
    authority: "European Central Bank",
    url: "https://www.ecb.europa.eu/rss/press.html",
    categories: [],
  },
  {
    id: "press_boc",
    authority: "Bank of Canada",
    url: "https://www.bankofcanada.ca/content_type/press-releases/feed/",
    categories: [],
  },
  {
    id: "press_ons",
    authority: "UK ONS",
    url: "https://www.ons.gov.uk/releasecalendar?rss",
    categories: [],
  },
  {
    id: "press_ofsi",
    authority: "UK OFSI",
    // Sanctions. The one lane where "who was designated today" is the whole
    // story and there is no filing behind it to fetch.
    url: "https://ofsi.blog.gov.uk/feed/",
    categories: [],
  },
  {
    id: "press_rbi",
    authority: "Reserve Bank of India",
    url: "https://www.rbi.org.in/pressreleases_rss.xml",
    categories: [],
  },
  {
    id: "press_sebi",
    authority: "SEBI",
    // India's securities regulator: the enforcement lane for a market the
    // desk currently has zero coverage of. NSE and BSE stay parked (the
    // hosts reset our declared UA, verified 2026-07-27).
    url: "https://www.sebi.gov.in/sebirss.xml",
    categories: [],
  },
  {
    id: "press_sec_speeches",
    authority: "SEC Commissioners",
    // Statements and speeches, distinct from press_sec_enforcement. This is
    // where policy direction is signalled before it becomes a rule.
    url: "https://www.sec.gov/news/speeches-statements.rss",
    categories: [],
  },
  {
    id: "press_cfpb",
    authority: "CFPB",
    url: "https://www.consumerfinance.gov/about-us/newsroom/feed/",
    categories: [],
  },
  {
    id: "press_gao",
    authority: "GAO",
    // Government Accountability Office reports. Slow-moving and often the
    // first public accounting of a programme's real numbers.
    url: "https://www.gao.gov/rss/reports.xml",
    categories: [],
  },
  {
    id: "press_eba",
    authority: "European Banking Authority",
    url: "https://www.eba.europa.eu/rss.xml",
    categories: [],
    // The EBA feed carries conference and paper calls alongside supervisory
    // actions; those are academic housekeeping, not supervision.
    skipTitle: /\b(call for papers|research workshop|vacancy|recruit\w*)\b/i,
  },
  {
    id: "press_boe_news",
    authority: "Bank of England",
    // News and publications. rate_boe already tracks the Bank Rate series
    // itself; this is everything around it.
    url: "https://www.bankofengland.co.uk/rss/news",
    categories: [],
  },
  {
    id: "press_riksbank",
    authority: "Sveriges Riksbank",
    url: "https://www.riksbank.se/en-gb/rss/press-releases/",
    categories: [],
  },
  {
    id: "press_bea",
    authority: "Bureau of Economic Analysis",
    // GDP, personal income and outlays, the trade balance. The releases
    // themselves, hours before anyone's summary of them.
    url: "https://apps.bea.gov/rss/rss.xml",
    categories: [],
  },
  {
    id: "press_eia",
    authority: "US Energy Information Administration",
    // "Today in Energy": EIA publishing its own series as short notes, so
    // this is a primary source reading its own data, not a vendor's read.
    url: "https://www.eia.gov/rss/todayinenergy.xml",
    categories: [],
    // The feed mixes data notes with explainers, and the explainers are
    // reliably phrased as questions ("What are tank bottoms?"). A question
    // is a teaching post, not an event.
    skipTitle: /\?\s*$/,
  },
  {
    id: "press_wto",
    authority: "WTO",
    // Disputes, panel reports and the quarterly goods-trade series.
    url: "https://www.wto.org/library/rss/latest_news_e.xml",
    categories: [],
    // Two kinds of noise: technical-assistance donations ("Lithuania gives
    // EUR 30,000 to help..."), which are announcements about the WTO rather
    // than about trade, and the same question-shaped explainers as EIA.
    skipTitle: /\?\s*$|\b(gives|donates|contributes|pledges)\s+(EUR|US\$|CHF|£|\$)/i,
  },
  {
    id: "press_cma",
    authority: "UK CMA",
    // Merger inquiries and anti-competitive conduct cases, which name the
    // parties in the title ("Vodafone / CK Hutchison JV merger inquiry").
    url: "https://www.gov.uk/government/organisations/competition-and-markets-authority.atom",
    categories: [],
    skipTitle: GOV_UK_DOCUMENT_PREFIX,
  },
  {
    id: "press_hmt",
    authority: "HM Treasury",
    url: "https://www.gov.uk/government/organisations/hm-treasury.atom",
    categories: [],
    skipTitle: GOV_UK_DOCUMENT_PREFIX,
  },
  {
    id: "press_finma",
    authority: "FINMA",
    // Swiss market supervisor. Concludes proceedings against named firms,
    // which is the shape this desk can actually cite.
    url: "https://www.finma.ch/en/rss/news/",
    categories: [],
    // The /en/ feed is NOT all English: roughly half of it is German
    // sanctions notices ("Aktualisierte Sanktionsmeldung: Russland"), and
    // this desk has no translator, so posting one would mean relaying a
    // regulator's wording in a language we did not read.
    //
    // Only "Aktualisierte" was observed on 2026-08-01; the other openers are
    // prophylactic. RESIDUAL RISK, stated rather than hidden: a German item
    // starting some other way still gets through. The endpoint being /en/ is
    // not a guarantee of language, which is the general lesson.
    skipTitle: /^(Aktualisierte|Sanktionsmeldung|Medienmitteilung|Verfügung|Mitteilung)\b/i,
  },
];

export interface PressItem {
  title: string;
  link: string;
  publishedIso: string;
  categories: string[];
  guid: string;
  /** RSS <description>, tag-stripped and capped — the item's own summary of
   *  itself, captured at ingest as grounding text (p4-01). Null when the
   *  feed carries none or only boilerplate. */
  description: string | null;
}

function parseDate(v: string): string {
  // Feeds here use RFC-822 ("Mon, 27 Jul 2026 09:20:41 GMT") and a
  // human format ("Monday, July 27, 2026 - 15:30"). Date handles both;
  // anything it cannot read is dropped rather than guessed.
  const cleaned = stripCdata(v).replace(/\s+-\s+/, " ").trim();
  let d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) {
    // SEBI prints "31 Jul, 2026 +0530" -- a comma after the month and NO
    // time at all, which Date rejects outright. Drop the comma and supply
    // midnight so a date-only stamp still dates the item, rather than
    // discarding a real filing over punctuation.
    const dateOnly = /^(\d{1,2})\s+([A-Za-z]{3,})[,]?\s+(\d{4})\s*([+-]\d{4})?$/.exec(cleaned);
    if (dateOnly) {
      d = new Date(`${dateOnly[1]} ${dateOnly[2]} ${dateOnly[3]} 00:00:00 ${dateOnly[4] ?? "+0000"}`);
    }
  }
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** Feeds wrap values in CDATA inconsistently, even within one document. */
function stripCdata(v: string): string {
  return v.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}

/**
 * First non-empty value among several tag names.
 *
 * The fanout mixes three feed dialects and they disagree about which tag
 * carries which fact: RSS 2.0 uses pubDate, RSS 1.0/RDF uses dc:date, Atom
 * uses published or updated. Reading only the first is how a feed returns
 * 200, contains items, and still parses to nothing.
 */
function firstOf(block: string, tags: readonly string[]): string {
  for (const t of tags) {
    const v = stripCdata(extractFirst(block, t) ?? "");
    if (v) return v;
  }
  return "";
}

/** Descriptions this short restate the title or the feed's boilerplate;
 *  storing them as grounding would teach the model nothing. */
const MIN_DESCRIPTION_CHARS = 40;
const MAX_DESCRIPTION_CHARS = 2_000;

function parseDescription(item: string, title: string): string | null {
  const raw = extractFirst(item, "description") ?? "";
  const unwrapped = raw.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
  // Feeds embed HTML inside descriptions (CFTC, FCA); strip to text. URLs are
  // scrubbed because this text feeds the URL-free generation prompt.
  const text = scrubUrls(htmlToText(decodeEntities(unwrapped))).slice(0, MAX_DESCRIPTION_CHARS).trim();
  if (text.length < MIN_DESCRIPTION_CHARS) return null;
  if (text.toLowerCase() === title.toLowerCase()) return null;
  return text;
}

export function parsePressFeed(xml: string): PressItem[] {
  const out: PressItem[] = [];
  const doc = stripBom(xml);
  // RSS and RDF call an item <item>; Atom calls it <entry>. Take whichever
  // this document actually uses rather than assuming RSS -- OFSI and ONS
  // both serve Atom and parsed to zero under the item-only reader.
  const blocks = extractAll(doc, "item");
  const items = blocks.length > 0 ? blocks : extractAll(doc, "entry");
  for (const item of items) {
    const title = decodeEntities(firstOf(item, ["title"]));
    // Atom puts the URL in an attribute, not a text node, and lists several
    // rel types -- self and replies among them. Only the alternate link is
    // the article.
    const linkTag = firstOf(item, ["link"]);
    const atomHref =
      /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(item)?.[1] ??
      /<link\b[^>]*href=["']([^"']+)["']/i.exec(item)?.[1] ??
      "";
    const link = (linkTag || atomHref || "").trim();
    const published = parseDate(firstOf(item, ["pubDate", "dc:date", "published", "updated"]));
    if (!title || !link || !published) continue;
    out.push({
      title,
      link,
      publishedIso: published,
      categories: extractAll(item, "category").map((c) => decodeEntities(c.trim())).filter(Boolean),
      guid: (extractFirst(item, "guid") ?? link).trim(),
      description: parseDescription(item, title),
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
            rawText: item.description,
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
