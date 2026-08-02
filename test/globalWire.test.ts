import { describe, expect, it } from "vitest";
import DOJ from "./fixtures/press-doj.xml.fixture?raw";
import FED_SPEECHES from "./fixtures/press-fed-speeches.xml.fixture?raw";
import ECB from "./fixtures/press-ecb.xml.fixture?raw";
import BOC from "./fixtures/press-boc.xml.fixture?raw";
import ONS from "./fixtures/press-ons.xml.fixture?raw";
import OFSI from "./fixtures/press-ofsi.xml.fixture?raw";
import RBI from "./fixtures/press-rbi.xml.fixture?raw";
import SEBI from "./fixtures/press-sebi.xml.fixture?raw";
import SEC_SPEECHES from "./fixtures/press-sec-speeches.xml.fixture?raw";
import CFPB from "./fixtures/press-cfpb.xml.fixture?raw";
import GAO from "./fixtures/press-gao.xml.fixture?raw";
import EBA from "./fixtures/press-eba.xml.fixture?raw";
import BOE_NEWS from "./fixtures/press-boe.xml.fixture?raw";
import RIKSBANK from "./fixtures/press-riksbank.xml.fixture?raw";
import BEA from "./fixtures/press-bea.xml.fixture?raw";
import EIA from "./fixtures/press-eia.xml.fixture?raw";
import WTO from "./fixtures/press-wto.xml.fixture?raw";
import CMA from "./fixtures/press-cma.xml.fixture?raw";
import HMT from "./fixtures/press-hmt.xml.fixture?raw";
import FINMA from "./fixtures/press-finma.xml.fixture?raw";
import { draftPress, parsePressFeed, PRESS_SOURCES } from "../src/ingesters/regulatoryPress";
import { isFreshAtIngest, isFreshDateOnly } from "../src/ingesters/shared";
import { PRESS_ATTRIBUTION } from "../src/ingesters/pressAttribution";

// Every feed below was live-probed 2026-08-01 and kept only if it returned
// 200 AND parsed to three or more items. Eleven candidates failed and are
// recorded in the verification doc.

const FIXTURES: readonly [string, string][] = [
  ["press_doj", DOJ],
  ["press_fed_speeches", FED_SPEECHES],
  ["press_ecb", ECB],
  ["press_boc", BOC],
  ["press_ons", ONS],
  ["press_ofsi", OFSI],
  ["press_rbi", RBI],
  ["press_sebi", SEBI],
  ["press_sec_speeches", SEC_SPEECHES],
  ["press_cfpb", CFPB],
  ["press_gao", GAO],
  ["press_eba", EBA],
  ["press_boe_news", BOE_NEWS],
  ["press_riksbank", RIKSBANK],
  ["press_bea", BEA],
  ["press_eia", EIA],
  ["press_wto", WTO],
  ["press_cma", CMA],
  ["press_hmt", HMT],
  ["press_finma", FINMA],
];

describe("global wire batch 1: the parser reads every new feed", () => {
  it.each(FIXTURES)("%s parses to dated, titled, linked items", (id, xml) => {
    const items = parsePressFeed(xml);
    expect(items.length, id).toBeGreaterThan(0);
    for (const it of items) {
      // A press item with no title or no link cannot be posted or cited, and
      // an undated one cannot be judged fresh. Any of the three missing means
      // the feed's shape is not what the parser assumes.
      expect(it.title.trim().length, `${id} title`).toBeGreaterThan(0);
      expect(it.link, `${id} link`).toMatch(/^https?:\/\//);
      expect(it.publishedIso, `${id} date`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("covers both RSS and Atom, since the fanout mixes them", () => {
    // ONS and OFSI serve Atom; the rest serve RSS. One parser, both shapes.
    expect(OFSI).toContain("<feed");
    expect(DOJ).toContain("<rss");
    expect(parsePressFeed(OFSI).length).toBeGreaterThan(0);
    expect(parsePressFeed(DOJ).length).toBeGreaterThan(0);
  });
});

describe("every source can be cited", () => {
  it("resolves an attribution for every source, with none generic", () => {
    // A source whose authority is absent from the map renders nothing at
    // all: resolveAttribution returns null and the post is refused. Adding a
    // source without its citation is therefore a silent no-post, which is
    // exactly the failure this asserts against.
    for (const s of PRESS_SOURCES) {
      const cite = PRESS_ATTRIBUTION[s.authority];
      expect(cite, `${s.id} -> ${s.authority}`).toBeTruthy();
      expect(cite, s.id).toMatch(/^per /);
      expect(cite, s.id).not.toMatch(/issuing authority|the regulator/i);
    }
    expect(PRESS_SOURCES.length).toBe(26);
  });

  it("gives each source its own authority, so no two sources share a citation key", () => {
    const authorities = PRESS_SOURCES.map((s) => s.authority);
    expect(new Set(authorities).size).toBe(authorities.length);
  });

  it("registers no URL twice, however the ids differ", () => {
    // Batch 3 probed 42 candidates and three of the twelve that came back
    // usable -- FTC competition, the FCA, and the EU Commission -- were
    // already registered under the identical URL. Nothing failed: they would
    // have been adopted a second time under new ids, doubling the poll rate
    // on those hosts and filing every item twice for dedup to absorb.
    //
    // Caught by eye while reading the source list. This asserts it instead.
    const urls = PRESS_SOURCES.map((s) => s.url);
    const dupes = urls.filter((u, i) => urls.indexOf(u) !== i);
    expect(dupes).toEqual([]);
  });

  it("registers no ENDPOINT twice, however the query string differs", () => {
    // Exact-string equality would have caught only two of the three.
    //
    // Re-verifying the batch-3 record on 2026-08-02 found the EU Commission
    // case is not an identical URL: the registered source carries
    // `?language=en&pagesize=20` and the probe used `?language=en`. Adopt the
    // probe URL alongside the existing row and BOTH register, the exact-match
    // guard passes, and the host is polled twice for the same feed with a
    // different page size.
    //
    // Host + path, query discarded. Safe against the current 26 because no
    // two press sources legitimately share an endpoint and differ only by
    // query -- checked before tightening, since a guard that fails on correct
    // config gets deleted rather than fixed.
    const key = (u: string) => {
      const p = new URL(u);
      return `${p.host.toLowerCase()}${p.pathname.replace(/\/$/, "").toLowerCase()}`;
    };
    const keys = PRESS_SOURCES.map((s) => key(s.url));
    const collisions = keys
      .map((k, i) => ({ k, id: PRESS_SOURCES[i]!.id }))
      .filter(({ k }, i) => keys.indexOf(k) !== i)
      .map(({ k, id }) => `${id} -> ${k}`);
    expect(collisions).toEqual([]);
  });
});

describe("a feed with no date at all is refused, not dated by us", () => {
  it("records why ESMA was rejected despite returning a usable-looking feed", () => {
    // ESMA's items carry ONLY description, link and title -- no pubDate, no
    // dc:date, no published, no updated. It returned 200 with ten items and
    // looked adoptable right up until it went through the parser.
    //
    // The tempting fix is to date it by fetch time. That would make every
    // item look fresh, so a month-old release would post as news -- claiming
    // a date we do not have, which is the one thing this desk cannot do.
    // Refusing the source is the cheaper error.
    const noDate = `<rss version="2.0"><channel><item>
      <title>ESMA publishes final report</title>
      <link>https://www.esma.europa.eu/x</link>
      <description>Some text.</description>
    </item></channel></rss>`;
    expect(parsePressFeed(noDate)).toEqual([]);
  });
});

describe("batch 3 noise filters", () => {
  const src = (id: string) => PRESS_SOURCES.find((s) => s.id === id)!;

  it("drops the gov.uk document library and keeps the press releases", () => {
    // gov.uk serves one Atom feed per organisation, so the CMA's merger
    // inquiries arrive interleaved with its spending disclosures. The
    // document type prefix is the only thing separating them.
    for (const doc of [
      "Transparency data: CMA: spending over £500, June 2026",
      "Corporate report: CMA: workforce management information June 2026",
      "Corporate report: Mergers orders and undertakings register",
      "Guidance: Orange Book",
      "Correspondence: Chancellor letter to the Treasury Select Committee",
      "Policy paper: G7 Cyber Expert Group: Reconnection Framework",
      "Accredited official statistics: Public Spending Statistics release: July 2026",
    ]) {
      expect(src("press_cma").skipTitle!.test(doc), doc).toBe(true);
      expect(src("press_hmt").skipTitle!.test(doc), doc).toBe(true);
    }
    for (const news of [
      "Vodafone / CK Hutchison JV merger inquiry",
      "Suspected anti-competitive conduct in relation to the supply of waste management services",
      "Co-operative Group / Southern Co-operative merger inquiry",
      "UK pension giants join forces to unlock £1bn to back Britain's innovators",
      // A real headline can carry a colon too, which is why the filter is an
      // explicit prefix list and not /^[A-Z][a-z ]+:/.
      "Vodafone: CMA opens phase 2 inquiry",
    ]) {
      expect(src("press_cma").skipTitle!.test(news), news).toBe(false);
    }
  });

  it("drops the question-shaped explainers on EIA and WTO", () => {
    for (const explainer of [
      "What are tank bottoms?",
      "Why is transit in goods free but trade is not?",
    ]) {
      expect(src("press_eia").skipTitle!.test(explainer), explainer).toBe(true);
      expect(src("press_wto").skipTitle!.test(explainer), explainer).toBe(true);
    }
    for (const data of [
      "China's crude oil imports fell in the second quarter",
      "Commercial crude oil inventories increased by 2.0 million barrels",
    ]) {
      expect(src("press_eia").skipTitle!.test(data), data).toBe(false);
    }
  });

  it("drops WTO technical-assistance donations, which are news about the WTO", () => {
    expect(
      src("press_wto").skipTitle!.test(
        "Lithuania gives EUR 30,000 to help developing economies and LDCs improve trade skillset",
      ),
    ).toBe(true);
    for (const trade of [
      "Brazil initiates dispute regarding additional duties imposed by the United States",
      "WTO panel issues report regarding Turkish measures on EVs and other types of vehicles",
      "Global goods trade resilient in the first quarter of 2026 despite war in Middle East",
    ]) {
      expect(src("press_wto").skipTitle!.test(trade), trade).toBe(false);
    }
  });

  it("refuses the German half of FINMA's English feed", () => {
    // The endpoint is /en/rss/news/ and about half its items are German.
    // Serving them would mean relaying a regulator's exact wording in a
    // language the desk never read.
    for (const de of [
      "Aktualisierte Sanktionsmeldung: Russland",
      "Aktualisierte Sanktionsmeldung: ISIL (Da'esh) und Al-Kaida",
      "Aktualisierte Sanktionsmeldung",
    ]) {
      expect(src("press_finma").skipTitle!.test(de), de).toBe(true);
    }
    for (const en of [
      "FINMA concludes proceedings against Swiss Fund Management AG in liquidation",
      "FINMA publishes a new ordinance on the liquidity of banks and securities firms",
      "FINMA guidance on quantum computing",
    ]) {
      expect(src("press_finma").skipTitle!.test(en), en).toBe(false);
    }
  });
});

describe("a date-only stamp is anchored at UTC midnight, not the source's", () => {
  it("dates SEBI on the day SEBI published, not the day before", () => {
    // THE BUG. "31 Jul, 2026 +0530" has NO time of day, so the offset applies
    // to a moment the source never gave. Honouring it anchored the item at
    // IST midnight -> 2026-07-30T18:30:00.000Z, and publishedIso is printed
    // verbatim by the REGULATORY_NEWS date beat. The post stated a calendar
    // day BEFORE the one SEBI published on.
    //
    // Nothing downstream catches it: every validator asks whether a number
    // came from a parsed field, and this one did. The fabrication floor
    // guarantees provenance, not correctness.
    const xml = `<rss><channel><item>
      <title>Final Order in the matter of an unauthorised pledge</title>
      <link>https://www.sebi.gov.in/x</link>
      <pubDate>31 Jul, 2026 +0530</pubDate>
    </item></channel></rss>`;
    const [item] = parsePressFeed(xml);
    expect(item!.publishedIso).toBe("2026-07-31T00:00:00.000Z");
    expect(item!.publishedIso).not.toBe("2026-07-30T18:30:00.000Z");
    expect(item!.dateOnly).toBe(true);
  });

  it("leaves a stamp that DOES carry a time exactly where the source put it", () => {
    // The offset is only meaningless when there is no time to apply it to.
    const xml = `<rss><channel><item><title>A thing happened</title>
      <link>https://example.gov/x</link>
      <pubDate>Mon, 27 Jul 2026 09:20:41 GMT</pubDate></item></channel></rss>`;
    const [item] = parsePressFeed(xml);
    expect(item!.publishedIso).toBe("2026-07-27T09:20:41.000Z");
    expect(item!.dateOnly).toBe(false);
  });

  it("gives a date-only item the whole-day freshness allowance", () => {
    // Any midnight anchor starts the 24h gate BEFORE the source's working
    // day, so the usable window is whatever is left after publication.
    // Take a SEBI order filed 23:45 IST on 31 July (18:15Z):
    //
    //   old anchor, IST midnight (2026-07-30T18:30Z)  24h gate expires 18:30Z
    //                                                  -> fresh for 15 MINUTES
    //   new anchor, UTC midnight (2026-07-31T00:00Z)  24h gate expires 00:00Z
    //                                                  -> fresh for 5h 45m
    //   new anchor + whole-day allowance               48h -> fresh for ~29h
    //
    // Only the third survives an hourly poll plus a queue that batches. The
    // first two log the order and it never reaches anyone.
    const anchored = "2026-07-31T00:00:00.000Z";
    const nextMorning = new Date("2026-08-01T06:00:00.000Z"); // 11:30 IST, day after
    expect(isFreshAtIngest(anchored, nextMorning)).toBe(false);
    expect(isFreshDateOnly(anchored, nextMorning)).toBe(true);
  });
});

describe("a headline that ends in a period does not render two", () => {
  it("trims the title's own terminal period", () => {
    const src = PRESS_SOURCES.find((s) => s.id === "press_sebi")!;
    const line = draftPress(src, {
      title: "Final Order against Zee Entertainment Enterprises Ltd.",
      link: "https://www.sebi.gov.in/x",
      publishedIso: "2026-07-31T00:00:00.000Z",
      categories: [],
      guid: "g",
      description: null,
      dateOnly: true,
    });
    expect(line).toMatch(/Ltd$/);
    expect(line).not.toContain("Ltd..");
  });
});

describe("two filters that did not remove what their comments claimed", () => {
  const src = (id: string) => PRESS_SOURCES.find((s) => s.id === id)!;

  it("DOJ drops grants under their formal name too", () => {
    // The filter said it removed grants; the alternative was the literal
    // "grant award", so the Notice of Funding Opportunity sailed through.
    for (const noise of [
      "Justice Department Announces Funding Opportunities to Advance Public Safety Efforts Across Tribal Nations",
      "Department Announces Notice of Funding Opportunity for FY2026",
      "Justice Department Announces Grant Award to Local Program",
    ]) {
      expect(src("press_doj").skipTitle!.test(noise), noise).toBe(true);
    }
    // A sentencing names a person and an amount and stays.
    for (const news of [
      "Former Executive Sentenced for Insider Trading Scheme",
      "Pharmaceutical Company Agrees to Pay $150 Million to Resolve Fraud Allegations",
    ]) {
      expect(src("press_doj").skipTitle!.test(news), news).toBe(false);
    }
  });

  it("EBA drops its periodic e-mail digest, as the EU Commission lane already does", () => {
    for (const digest of ["EBA E-mail alert 31 July, 2026", "EBA Email alert 24 July, 2026"]) {
      expect(src("press_eba").skipTitle!.test(digest), digest).toBe(true);
    }
    expect(
      src("press_eba").skipTitle!.test("EBA publishes final draft technical standards on liquidity"),
    ).toBe(false);
  });
});

describe("grounding text follows the same four dialects the dates do", () => {
  // Measured across all 20 adopted feeds on 2026-08-01: 21 of 60 items had
  // no description, and NINE of those were OFSI, CMA and HM Treasury -- all
  // Atom, all carrying <summary> the entire time. Reading only <description>
  // dropped it.
  //
  // This is the batch-1 date bug repeating. Atom was taught to the item
  // reader, the link reader and the date reader; the body was left behind,
  // because NOTHING FAILS when grounding text goes missing. The item still
  // parses, still queues, still posts. It just posts thinner, and thin
  // payloads are what push a model to reach outside the record.

  it("reads Atom <summary>, which three adopted sources use and none had", () => {
    for (const [id, xml] of [
      ["press_ofsi", OFSI],
      ["press_cma", CMA],
      ["press_hmt", HMT],
    ] as const) {
      const items = parsePressFeed(xml);
      expect(items.length, id).toBeGreaterThan(0);
      for (const it of items) {
        expect(it.description, `${id} description`).toBeTruthy();
        expect(it.description!.length, `${id} length`).toBeGreaterThan(0);
      }
    }
  });

  it("falls back through description, summary, content:encoded, content", () => {
    const wrap = (body: string) =>
      `<feed><entry><title>A regulator did a thing</title>
       <link rel="alternate" href="https://example.gov/x"/>
       <updated>2026-07-31T12:00:00Z</updated>${body}</entry></feed>`;
    const long = "The authority has concluded proceedings and set out its reasoning in full.";

    for (const tag of ["summary", "content", "content:encoded"]) {
      const items = parsePressFeed(wrap(`<${tag}>${long}</${tag}>`));
      expect(items[0]?.description, tag).toContain("concluded proceedings");
    }
    // <description> still wins when a feed carries both.
    const both = parsePressFeed(wrap(`<description>${long} Primary.</description><summary>Secondary secondary secondary.</summary>`));
    expect(both[0]?.description).toContain("Primary");
  });

  it("still refuses a description that only restates the title", () => {
    // SEBI copies the title verbatim into <description>. Widening the tag
    // list must not open a path around the guard that drops it -- storing a
    // duplicate title as grounding teaches the model nothing while looking
    // like coverage.
    const dupe = parsePressFeed(
      `<rss><channel><item><title>Final Order in the matter of unauthorised pledge of property</title>
       <link>https://www.sebi.gov.in/x</link><pubDate>31 Jul, 2026 +0530</pubDate>
       <description>Final Order in the matter of unauthorised pledge of property</description>
       </item></channel></rss>`,
    );
    expect(dupe.length).toBe(1);
    expect(dupe[0]!.description).toBeNull();
  });
});

describe("DOJ needs its noise filter", () => {
  it("skips departmental items that are not market intelligence", () => {
    const doj = PRESS_SOURCES.find((s) => s.id === "press_doj")!;
    expect(doj.skipTitle).toBeTruthy();
    for (const noise of [
      "Justice Department Announces Grant Award to Local Program",
      "President Nominates Jane Doe as United States Attorney",
      "Swearing-In Ceremony Held for New Deputy",
    ]) {
      expect(doj.skipTitle!.test(noise), noise).toBe(true);
    }
    for (const news of [
      "Pharmaceutical Company Agrees to Pay $150 Million to Resolve Fraud Allegations",
      "Former Executive Charged With Insider Trading",
    ]) {
      expect(doj.skipTitle!.test(news), news).toBe(false);
    }
  });
});
