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
  it("resolves an attribution for all 14, with none generic", () => {
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
    expect(PRESS_SOURCES.length).toBe(20);
  });

  it("gives each source its own authority, so no two sources share a citation key", () => {
    const authorities = PRESS_SOURCES.map((s) => s.authority);
    expect(new Set(authorities).size).toBe(authorities.length);
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
