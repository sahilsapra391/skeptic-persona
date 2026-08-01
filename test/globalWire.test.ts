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
import { parsePressFeed, PRESS_SOURCES } from "../src/ingesters/regulatoryPress";
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
