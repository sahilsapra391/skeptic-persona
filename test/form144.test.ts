import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FEED_FIXTURE from "./fixtures/form144-current.atom.xml?raw";
import XML_PREFIXED from "./fixtures/form144-prefixed.xml?raw";
import XML_BARE from "./fixtures/form144-bare.xml?raw";
import {
  draftForm144,
  FORM144_FEED,
  NOTICE_ALERT_PCT_OUTSTANDING,
  NOTICE_ALERT_USD,
  NOTICE_POSTABLE_USD,
  parseForm144Feed,
  parseForm144Xml,
  pollForm144,
  relationshipLabel,
  scoreForm144,
  SOURCE,
  usDateToIso,
} from "../src/ingesters/form144";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_LOG_ONLY, SCORE_POSTABLE, SCORE_AUTO_ALERT } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixtures captured 2026-07-27T20:35Z. These ARE the parse contract.
const NOW = new Date("2026-07-27T21:00:00Z"); // filings stamped 16:34 ET same day

describe("parseForm144Feed (live fixture)", () => {
  const parsed = parseForm144Feed(FEED_FIXTURE);

  it("collapses the per-seller/per-issuer duplicate entries onto unique accessions", () => {
    // VERIFIED: the first two entries in the live feed share accession
    // 0001628280-26-049826 (once as (Reporting), once as (Subject)).
    expect(FEED_FIXTURE.split("<entry>").length - 1).toBe(10);
    expect(parsed.length).toBeLessThan(10);
    expect(new Set(parsed.map((e) => e.accession)).size).toBe(parsed.length);
  });

  it("carries an archives dir, an index url and a UTC timestamp for every entry", () => {
    for (const e of parsed) {
      expect(e.dirUrl).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+$/);
      expect(e.indexUrl.startsWith(e.dirUrl)).toBe(true);
      expect(e.filedIso).toMatch(/Z$/); // ET offset normalized at parse
    }
  });
});

describe("parseForm144Xml — BOTH namespace conventions", () => {
  // The trap this source hides: filing agents disagree on prefixes, and a
  // parser bound to one convention silently returns nothing for the other.
  it("parses the own:-prefixed filing (Workiva) with exact verified fields", () => {
    const doc = parseForm144Xml(XML_PREFIXED);
    expect(doc).toMatchObject({
      issuerCik: "0001699136",
      issuerName: "Cactus Inc",
      sellerName: "Bender Investment Company",
      unitsSold: 100000,
      aggregateMarketValue: 5500000,
      unitsOutstanding: 69418430,
      approxSaleDate: "07/27/2026",
      approxSaleIso: "2026-07-27",
      exchange: "NYSE",
      broker: "Merrill Lynch",
    });
    expect(doc?.relationships).toEqual(["Member of 10% Owner"]);
    // 100,000 / 69,418,430 = 0.144%
    expect(doc?.pctOfOutstanding).toBeCloseTo(0.14, 2);
  });

  it("parses the UNPREFIXED filing with equal fidelity", () => {
    const doc = parseForm144Xml(XML_BARE);
    expect(doc).toMatchObject({
      issuerName: "PARK AEROSPACE CORP",
      unitsSold: 2500,
      aggregateMarketValue: 90000, // filed as "90000.00"
    });
    expect(doc?.acquisitions[0]?.nature).toBe("Cashless Exercise of Stock Options");
    expect(doc?.acquisitions[0]?.isGift).toBe(false);
  });

  it("returns null for a non-144 body rather than a half-parsed shell", () => {
    expect(parseForm144Xml("<html>maintenance</html>")).toBeNull();
    // Missing the seller name is fatal: the post's subject would be unknown.
    expect(parseForm144Xml("<formData><issuerCik>1</issuerCik></formData>")).toBeNull();
  });
});

describe("usDateToIso", () => {
  it("normalizes the filing's MM/DD/YYYY, and refuses anything else", () => {
    expect(usDateToIso("07/27/2026")).toBe("2026-07-27");
    expect(usDateToIso("7/4/2026")).toBe("2026-07-04");
    expect(usDateToIso("2026-07-27")).toBeNull(); // already ISO: not our format
    expect(usDateToIso("")).toBeNull();
    expect(usDateToIso(null)).toBeNull();
  });
});

describe("scoreForm144", () => {
  const base = parseForm144Xml(XML_PREFIXED)!;

  it("an unparsed dollar value can never be postable", () => {
    expect(scoreForm144({ ...base, aggregateMarketValue: null })).toBe(SCORE_LOG_ONLY);
  });

  it("grades on parsed dollars", () => {
    expect(scoreForm144({ ...base, aggregateMarketValue: NOTICE_ALERT_USD, pctOfOutstanding: 0 })).toBe(SCORE_AUTO_ALERT);
    expect(scoreForm144({ ...base, aggregateMarketValue: NOTICE_POSTABLE_USD, pctOfOutstanding: 0 })).toBe(SCORE_POSTABLE);
    expect(scoreForm144({ ...base, aggregateMarketValue: 999, pctOfOutstanding: 0 })).toBe(SCORE_LOG_ONLY);
  });

  it("a small sale that is a large share of the float still alerts", () => {
    // Size alone would miss this; the float share is what makes it news.
    expect(
      scoreForm144({ ...base, aggregateMarketValue: NOTICE_POSTABLE_USD, pctOfOutstanding: NOTICE_ALERT_PCT_OUTSTANDING }),
    ).toBe(SCORE_AUTO_ALERT);
  });
});

describe("draftForm144", () => {
  it("states only parsed fields, with the relationship verbatim from the filing", () => {
    const doc = parseForm144Xml(XML_PREFIXED)!;
    const d = draftForm144(doc);
    expect(d).toBe(
      "Form 144: Bender Investment Company (Member of 10% Owner) filed notice to sell 100,000 shares, $5.5M of Cactus Inc on or after 07/27/2026",
    );
    expect(d).not.toContain("—");
    // The label is the filing's own words, never normalized to "10% Owner".
    expect(relationshipLabel(doc)).toBe("Member of 10% Owner");
  });

  it("omits what did not parse instead of guessing", () => {
    const doc = parseForm144Xml(XML_PREFIXED)!;
    const d = draftForm144({ ...doc, unitsSold: null, aggregateMarketValue: null, approxSaleDate: null });
    expect(d).toBe("Form 144: Bender Investment Company (Member of 10% Owner) filed notice to sell of Cactus Inc");
    // No SHARE COUNT, no DOLLARS, no DATE — only the form name and the
    // relationship label (both verbatim from the filing) carry digits.
    expect(d).not.toMatch(/\$/);
    expect(d).not.toContain("100,000");
    expect(d).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });
});

describe("INSIDER_NOTICE archetype", () => {
  const payload = {
    factLine: "Form 144: X (Officer) filed notice to sell 1,000 shares, $2.0M of ACME on or after 07/27/2026",
    sellerName: "X",
    issuerName: "ACME",
    relationshipLabel: "Officer",
    unitsSold: 1000,
    aggregateMarketValue: 2_000_000,
    broker: "Merrill Lynch",
    pctOfOutstanding: 0.2,
  };

  it("renders fact + attribution + one gated beat", () => {
    const r = renderPost(ARCHETYPES.INSIDER_NOTICE, payload, { seed: "n144:1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per SEC Form 144");
    expect(r.text).not.toContain("—");
    expect(r.text.split("\n")[0]).toContain("per SEC Form 144");
  });

  it("the float beat needs the computed share, and only fires when it is large", () => {
    const small = pickBeat(ARCHETYPES.INSIDER_NOTICE, payload, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(small?.beat.id).not.toBe("n144.pctFloat");

    const big = pickBeat(
      ARCHETYPES.INSIDER_NOTICE,
      { ...payload, pctOfOutstanding: 4.2 },
      { recentSkeletons: [], recentBeats: [] },
      0,
    );
    expect(big?.beat.id).toBe("n144.pctFloat");
    expect(big?.text).toBe("That is 4.2% of shares outstanding.");
  });

  it("the option-exercise beat gates on a PARSED boolean, never on prose", () => {
    const notExercise = pickBeat(
      ARCHETYPES.INSIDER_NOTICE,
      { ...payload, acquisitionIsExercise: false },
      { recentSkeletons: [], recentBeats: ["n144.noticeNotTrade", "n144.beforeNotAfter", "n144.brokerNamed"] },
      0,
    );
    expect(notExercise?.beat.id).not.toBe("n144.optionSale");
  });

  it("the broker beat cannot render when the broker did not parse", () => {
    const noBroker = pickBeat(
      ARCHETYPES.INSIDER_NOTICE,
      { ...payload, broker: null },
      { recentSkeletons: [], recentBeats: ["n144.noticeNotTrade", "n144.beforeNotAfter"] },
      0,
    );
    expect(noBroker?.beat.id).not.toBe("n144.brokerNamed");
  });
});

describe("pollForm144 end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const SEC = "https://www.sec.gov";
  const FEED_PATH = FORM144_FEED.replace(SEC, "");

  it("feed -> stubs -> detail -> postable item, deduping on re-poll", async () => {
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, FEED_FIXTURE);
    // Every stub resolves to the big prefixed filing ($5.5M -> postable).
    fetchMock
      .get(SEC)
      .intercept({ path: (p) => p.endsWith("/primary_doc.xml"), method: "GET" })
      .reply(200, XML_PREFIXED)
      .persist();

    await pollForm144(env, NOW, newTickBudget(60));

    const rows = await env.DB.prepare(
      "SELECT status, score, payload FROM items WHERE source = ?1 ORDER BY id",
    )
      .bind(SOURCE)
      .all<{ status: string; score: number; payload: string }>();
    expect(rows.results.length).toBeGreaterThan(0);

    const detailed = rows.results.filter((r) => JSON.parse(r.payload).phase === "detail");
    expect(detailed.length).toBeGreaterThan(0);
    const p = JSON.parse(detailed[0]!.payload) as Record<string, unknown>;
    expect(p.aggregateMarketValue).toBe(5500000);
    expect(p.factLine).toContain("Bender Investment Company");
    expect(p.pctOfOutstanding).toBeCloseTo(0.14, 2);

    // Re-poll inserts nothing new (dedup on accession).
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, FEED_FIXTURE);
    await pollForm144(env, NOW, newTickBudget(60));
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1")
      .bind(SOURCE)
      .first<{ n: number }>();
    expect(after?.n).toBe(rows.results.length);
  });

  it("a stale-at-ingest notice never reaches the queue", async () => {
    await env.DB.prepare("DELETE FROM items WHERE source = ?1").bind(SOURCE).run();
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, FEED_FIXTURE);
    // A week later: the fixture's filings are old news.
    const late = new Date("2026-08-03T21:00:00Z");
    await pollForm144(env, late, newTickBudget(60));

    const statuses = await env.DB.prepare("SELECT DISTINCT status FROM items WHERE source = ?1")
      .bind(SOURCE)
      .all<{ status: string }>();
    expect(statuses.results.map((r) => r.status)).toEqual(["logged"]);
  });
});
