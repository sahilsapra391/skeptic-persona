import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FEED_FIXTURE from "./fixtures/form4-current.atom.xml?raw";
import XML_DERIVATIVE from "./fixtures/form4-derivative-only.xml?raw";
import XML_NONDERIVATIVE from "./fixtures/form4-nonderivative.xml?raw";
import {
  BUY_ALERT_USD,
  BUY_POSTABLE_USD,
  checkCluster,
  CLUSTER_SOURCE,
  draftForm4,
  FORM4_FEED,
  type Form4Owner,
  type Form4Txn,
  ownerLabel,
  parseForm4Feed,
  parseForm4Xml,
  pollForm4,
  scoreForm4,
  SELL_POSTABLE_USD,
  totalsFor,
} from "../src/ingesters/form4";
import { newTickBudget } from "../src/lib/budget";
import { getSourceState, insertInsiderTrade, insertItem, type InsiderTradeRow } from "../src/lib/db";

const NOW = new Date("2026-07-25T06:00:00Z"); // fixtures filed Fri 2026-07-24 -> fresh

describe("parseForm4Feed (live fixture)", () => {
  const parsed = parseForm4Feed(FEED_FIXTURE);

  it("collapses the per-owner/per-issuer duplicate entries onto unique accessions", () => {
    // 40 raw entries; VERIFIED: each filing appears >=2x (Reporting + Issuer).
    expect(parsed.length).toBeLessThan(40);
    expect(parsed.length).toBeGreaterThan(0);
    expect(new Set(parsed.map((e) => e.accession)).size).toBe(parsed.length);
  });

  it("carries form type, filing dir, and UTC timestamps for every filing", () => {
    for (const e of parsed) {
      expect(["4", "4/A"]).toContain(e.formType);
      expect(e.dirUrl).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+$/);
      expect(e.indexUrl.startsWith(e.dirUrl)).toBe(true);
      expect(e.filedIso).toMatch(/Z$/);
    }
  });

  it("sees the fixture's 4/A amendments", () => {
    expect(parsed.some((e) => e.formType === "4/A")).toBe(true);
  });
});

describe("parseForm4Xml (live fixtures)", () => {
  it("derivative-only filing: Doximity CEO award, exact verified fields", () => {
    const doc = parseForm4Xml(XML_DERIVATIVE);
    expect(doc).toMatchObject({
      documentType: "4",
      issuerCik: "0001516513",
      issuerName: "Doximity, Inc.",
      ticker: "DOCS",
      derivativeCount: 1,
    });
    expect(doc?.nonDerivative).toEqual([]); // empty table element, no phantom rows
    expect(doc?.owners[0]).toMatchObject({
      cik: "0001863328",
      name: "Tangney Jeffrey",
      isDirector: true,
      isOfficer: true,
      officerTitle: "Chief Executive Officer",
    });
  });

  it("non-derivative filing: Loop director award, exact verified fields incl. absent optionals", () => {
    const doc = parseForm4Xml(XML_NONDERIVATIVE);
    expect(doc).toMatchObject({ issuerCik: "0001504678", issuerName: "Loop Industries, Inc.", ticker: "LOOP" });
    expect(doc?.owners[0]).toMatchObject({
      cik: "0001796961",
      name: "Sams Louise S",
      isDirector: true,
      isOfficer: false, // element ABSENT in the document -> false
      officerTitle: null,
    });
    expect(doc?.nonDerivative).toHaveLength(1);
    expect(doc?.nonDerivative[0]).toMatchObject({
      code: "A",
      acquiredDisposed: "A",
      shares: 105263,
      price: 0,
      sharesAfter: 259678,
      date: "2026-07-23",
    });
    // pct: prior = 259678 - 105263 = 154415 -> 105263/154415 = 68.2%
    expect(doc?.nonDerivative[0]?.pctChange).toBe(68.2);
  });

  it("returns null for non-ownership bodies", () => {
    expect(parseForm4Xml("<html>maintenance</html>")).toBeNull();
  });
});

const txn = (over: Partial<Form4Txn>): Form4Txn => ({
  securityTitle: "Common Stock",
  date: "2026-07-24",
  code: "P",
  acquiredDisposed: "A",
  shares: 10_000,
  price: 20,
  sharesAfter: 110_000,
  direct: true,
  pctChange: 10,
  ...over,
});

describe("totals + scoring", () => {
  it("only P/S transactions with BOTH shares and price parsed count toward totals", () => {
    const t = totalsFor([
      txn({ code: "P", shares: 10_000, price: 20 }), // $200k buy
      txn({ code: "S", shares: 1_000, price: 50 }), // $50k sell
      txn({ code: "A", shares: 999_999, price: 0 }), // award: ignored
      txn({ code: "P", shares: 5_000, price: null }), // unparsed price: ignored
    ]);
    expect(t).toEqual({ buyShares: 10_000, buyValue: 200_000, sellShares: 1_000, sellValue: 50_000 });
  });

  it("editorial thresholds", () => {
    expect(scoreForm4({ buyShares: 0, buyValue: BUY_ALERT_USD, sellShares: 0, sellValue: 0 })).toBe(3);
    expect(scoreForm4({ buyShares: 0, buyValue: BUY_POSTABLE_USD, sellShares: 0, sellValue: 0 })).toBe(2);
    expect(scoreForm4({ buyShares: 0, buyValue: 0, sellShares: 0, sellValue: SELL_POSTABLE_USD })).toBe(2);
    expect(scoreForm4({ buyShares: 0, buyValue: 99_999, sellShares: 0, sellValue: 0 })).toBe(1);
  });

  it("ownerLabel prefers the parsed officer title", () => {
    const base: Form4Owner = { cik: "1", name: "X", isDirector: true, isOfficer: true, isTenPercent: false, officerTitle: "CFO" };
    expect(ownerLabel(base)).toBe("CFO");
    expect(ownerLabel({ ...base, officerTitle: null, isOfficer: false })).toBe("Director");
    expect(ownerLabel({ ...base, officerTitle: null, isOfficer: false, isDirector: false, isTenPercent: true })).toBe("10% owner");
  });

  it("draft contains only parsed numbers and omits what didn't parse", () => {
    const doc = {
      documentType: "4",
      issuerCik: "0001516513",
      issuerName: "Doximity, Inc.",
      ticker: "DOCS",
      owners: [{ cik: "1", name: "Jane Doe", isDirector: false, isOfficer: true, isTenPercent: false, officerTitle: "CEO" }],
      nonDerivative: [txn({ code: "P", shares: 50_000, price: 12.34, sharesAfter: 1_250_000, pctChange: 4.2 })],
      derivativeCount: 0,
    };
    const d = draftForm4(doc, totalsFor(doc.nonDerivative));
    expect(d).toBe("Form 4: Jane Doe (CEO) bought 50,000 $DOCS at ~$12.34 ($617K) on 2026-07-24, stake now 1,250,000 shares (+4.2%)");
  });

  it("an unpriced buy in the same filing suppresses stake/pct and its date never leaks into the span", () => {
    const doc = {
      documentType: "4",
      issuerCik: "9",
      issuerName: "Mix Corp",
      ticker: "MIX",
      owners: [{ cik: "1", name: "Jane Doe", isDirector: true, isOfficer: false, isTenPercent: false, officerTitle: null }],
      nonDerivative: [
        txn({ code: "P", shares: 10_000, price: 20, sharesAfter: 110_000, pctChange: 10, date: "2026-07-24" }),
        // Footnote-only price: excluded from totals; its date and its huge
        // stake movement must not be composited with the priced line.
        txn({ code: "P", shares: 99_999, price: null, sharesAfter: 209_999, pctChange: 90.9, date: "2026-07-20" }),
      ],
      derivativeCount: 0,
    };
    const d = draftForm4(doc, totalsFor(doc.nonDerivative));
    expect(d).toBe("Form 4: Jane Doe (Director) bought 10,000 $MIX at ~$20.00 ($200K) on 2026-07-24");
    expect(d).not.toContain("stake now");
    expect(d).not.toContain("2026-07-20");
  });
});

let seedSeq = 0;
async function seedTrade(over: Partial<InsiderTradeRow>): Promise<void> {
  // insider_trades.item_id has a real FK; every seeded row gets a lake item.
  const item = await insertItem(env.DB, {
    source: "edgar_form4",
    externalId: `SEED-${++seedSeq}`,
    category: "insider",
    eventAt: null,
    sourceUrl: "https://www.sec.gov/seed",
    payload: {},
    score: 1,
    status: "logged",
  });
  await insertInsiderTrade(env.DB, {
    itemId: item.id ?? 0,
    txnIndex: 0,
    issuerCik: "0001516513",
    ticker: "DOCS",
    insiderCik: "0000000001",
    insiderName: "Insider One",
    isOfficer: false,
    isDirector: true,
    officerTitle: null,
    side: "buy",
    code: "P",
    shares: 10_000,
    price: 20,
    sharesAfter: 100_000,
    pctChange: 11.1,
    transactionDate: "2026-07-23",
    isAmendment: false,
    ...over,
  });
}

describe("checkCluster", () => {
  const issuer = { cik: "0001516513", name: "Doximity, Inc.", ticker: "DOCS" };

  it("fires at 3 distinct P-buyers in the window, not before, and dedups on the member set", async () => {
    await seedTrade({ insiderCik: "1", insiderName: "A" });
    await seedTrade({ insiderCik: "2", insiderName: "B" });
    expect(await checkCluster(env, issuer, NOW)).toBe(false);

    await seedTrade({ insiderCik: "3", insiderName: "C" });
    expect(await checkCluster(env, issuer, NOW)).toBe(true);
    expect(await checkCluster(env, issuer, NOW)).toBe(false); // same member set -> dedup

    await seedTrade({ insiderCik: "4", insiderName: "D" });
    expect(await checkCluster(env, issuer, NOW)).toBe(true); // new member -> new cluster item

    const items = await env.DB.prepare("SELECT payload FROM items WHERE source = ?1 ORDER BY id")
      .bind(CLUSTER_SOURCE)
      .all<{ payload: string }>();
    expect(items.results.length).toBe(2);
    const draft = (JSON.parse(items.results[1]!.payload) as { factLine: string }).factLine;
    expect(draft).toContain("4 insiders bought $DOCS");
    // Attribution is appended by the template engine, not the fact builder.
    expect(draft).not.toContain("per SEC Form 4 filings");
  });

  it("sells and out-of-window buys don't count", async () => {
    await seedTrade({ issuerCik: "0009", ticker: "XYZ", insiderCik: "1", insiderName: "A" });
    await seedTrade({ issuerCik: "0009", ticker: "XYZ", insiderCik: "2", insiderName: "B", side: "sell", code: "S" });
    await seedTrade({ issuerCik: "0009", ticker: "XYZ", insiderCik: "3", insiderName: "C", transactionDate: "2026-07-10" });
    expect(await checkCluster(env, { cik: "0009", name: "XYZ Corp", ticker: "XYZ" }, NOW)).toBe(false);
  });

  it("name-rendering variants of the same CIK never inflate the insider count", async () => {
    await seedTrade({ issuerCik: "0011", ticker: "NVC", insiderCik: "1", insiderName: "Smith John" });
    await seedTrade({ issuerCik: "0011", ticker: "NVC", insiderCik: "1", insiderName: "SMITH JOHN" });
    await seedTrade({ issuerCik: "0011", ticker: "NVC", insiderCik: "2", insiderName: "B" });
    expect(await checkCluster(env, { cik: "0011", name: "NVC Corp", ticker: "NVC" }, NOW)).toBe(false); // 2 people

    await seedTrade({ issuerCik: "0011", ticker: "NVC", insiderCik: "3", insiderName: "C" });
    expect(await checkCluster(env, { cik: "0011", name: "NVC Corp", ticker: "NVC" }, NOW)).toBe(true);
    const item = await env.DB.prepare("SELECT payload FROM items WHERE source = ?1 AND external_id LIKE '0011:%'")
      .bind(CLUSTER_SOURCE)
      .first<{ payload: string }>();
    expect((JSON.parse(item!.payload) as { factLine: string }).factLine).toContain("3 insiders bought $NVC");
  });

  it("a footnote-only price yields 'amt n/a' for that member and suppresses the combined total", async () => {
    await seedTrade({ issuerCik: "0012", ticker: "FNP", insiderCik: "1", insiderName: "A" });
    await seedTrade({ issuerCik: "0012", ticker: "FNP", insiderCik: "2", insiderName: "B" });
    await seedTrade({ issuerCik: "0012", ticker: "FNP", insiderCik: "3", insiderName: "C", price: null });
    expect(await checkCluster(env, { cik: "0012", name: "FNP Corp", ticker: "FNP" }, NOW)).toBe(true);

    const item = await env.DB.prepare("SELECT payload FROM items WHERE source = ?1 AND external_id LIKE '0012:%'")
      .bind(CLUSTER_SOURCE)
      .first<{ payload: string }>();
    const draft = (JSON.parse(item!.payload) as { factLine: string }).factLine;
    expect(draft).toContain("C (Director) amt n/a");
    expect(draft).not.toContain("Combined");
    expect(draft).not.toContain("$0");
    // Attribution is appended by the template engine, not the fact builder.
    expect(draft).not.toContain("per SEC Form 4 filings");
  });
});

describe("pollForm4 end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const SEC = "https://www.sec.gov";
  const FEED_PATH = FORM4_FEED.replace(SEC, "");

  const SEND = { calls: [] as Array<Record<string, unknown>> };
  beforeAll(() => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: "/botTEST:TOKEN/sendMessage", method: "POST" })
      .reply(200, (opts) => {
        SEND.calls.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
        return JSON.stringify({ ok: true, result: { message_id: 700 + SEND.calls.length, chat: { id: 424242 } } });
      })
      .persist();
  });

  // Per-test filing directories: interceptors registered in one test can
  // never shadow another test's fetches (the mock-leak footgun documented in
  // webhook.test.ts).
  const dirOf = (seq: number): string => `/Archives/edgar/data/999/00009999992600000${seq}`;
  const accOf = (seq: number): string => `0009999999-26-00000${seq}`;
  const syntheticFeed = (formType: string, seq: number): string => `<feed>
    <entry>
      <title>${formType} - BUYER PERSON (0000000009) (Reporting)</title>
      <link rel="alternate" type="text/html" href="https://www.sec.gov${dirOf(seq)}/${accOf(seq)}-index.htm"/>
      <updated>2026-07-25T01:00:00-04:00</updated>
      <category scheme="https://www.sec.gov/" label="form type" term="${formType}"/>
      <id>urn:tag:sec.gov,2008:accession-number=${accOf(seq)}</id>
    </entry>
    <entry>
      <title>${formType} - ISSUER CO (0000000099) (Issuer)</title>
      <link rel="alternate" type="text/html" href="https://www.sec.gov${dirOf(seq)}/${accOf(seq)}-index.htm"/>
      <updated>2026-07-25T01:00:00-04:00</updated>
      <category scheme="https://www.sec.gov/" label="form type" term="${formType}"/>
      <id>urn:tag:sec.gov,2008:accession-number=${accOf(seq)}</id>
    </entry>
  </feed>`;

  const buyXml = `<?xml version="1.0"?><ownershipDocument>
    <documentType>4</documentType>
    <issuer><issuerCik>0000000099</issuerCik><issuerName>Issuer Co</issuerName><issuerTradingSymbol>ISCO</issuerTradingSymbol></issuer>
    <reportingOwner>
      <reportingOwnerId><rptOwnerCik>0000000009</rptOwnerCik><rptOwnerName>BUYER PERSON</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship>
    </reportingOwner>
    <nonDerivativeTable><nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-07-24</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>25000</value></transactionShares>
        <transactionPricePerShare><value>8.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>125000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction></nonDerivativeTable>
  </ownershipDocument>`;

  it("stub -> detail -> trade rows -> notification, with dedup on re-poll", async () => {
    const s0 = SEND.calls.length;
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, syntheticFeed("4", 1));
    fetchMock
      .get(SEC)
      .intercept({ path: `${dirOf(1)}/index.json` })
      .reply(200, JSON.stringify({ directory: { item: [{ name: "0009999999-26-000001-index-headers.html" }, { name: "ownership.xml" }] } }), {
        headers: { "content-type": "text/html" }, // Archives lies; parser must not care
      });
    fetchMock.get(SEC).intercept({ path: `${dirOf(1)}/ownership.xml` }).reply(200, buyXml);

    await pollForm4(env, NOW);

    // $200k P-buy -> postable -> notified.
    expect(SEND.calls.length).toBe(s0 + 1);
    const sentText = String(SEND.calls.at(-1)?.text);
    expect(sentText).toContain("BUYER PERSON (Chief Financial Officer)");
    expect(sentText).toContain("25,000 $ISCO");
    expect(sentText).toContain("per SEC Form 4");

    const item = await env.DB.prepare(
      "SELECT status, score FROM items WHERE source = 'edgar_form4' AND external_id = '0009999999-26-000001'",
    ).first<{ status: string; score: number }>();
    expect(item).toMatchObject({ status: "queued", score: 2 });

    const trade = await env.DB.prepare("SELECT * FROM insider_trades WHERE issuer_cik = '0000000099'").first<Record<string, unknown>>();
    expect(trade).toMatchObject({ side: "buy", code: "P", shares: 25000, price: 8, insider_name: "BUYER PERSON" });

    // Re-poll: same feed -> stub dedup -> no second detail fetch, no re-send.
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, syntheticFeed("4", 1));
    await pollForm4(env, NOW);
    expect(SEND.calls.length).toBe(s0 + 1);
  });

  it("4/A amendments are lake-only and never detail-fetched", async () => {
    const s0 = SEND.calls.length;
    // Unmatched fetches are swallowed by processDetail's catch, so a passive
    // absence of interceptors proves nothing — count hits explicitly.
    const detailHits = { n: 0 };
    fetchMock
      .get(SEC)
      .intercept({ path: `${dirOf(2)}/index.json` })
      .reply(200, () => {
        detailHits.n += 1;
        return JSON.stringify({ directory: { item: [] } });
      })
      .persist();
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, syntheticFeed("4/A", 2));
    await pollForm4(env, NOW);

    const item = await env.DB.prepare(
      "SELECT status FROM items WHERE source = 'edgar_form4' AND external_id = '0009999999-26-000002'",
    ).first<{ status: string }>();
    expect(item?.status).toBe("logged");
    expect(detailHits.n).toBe(0);
    expect(SEND.calls.length).toBe(s0);
  });

  it("budget exhaustion defers the detail phase, leaving stubs pending", async () => {
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, syntheticFeed("4", 3));
    // budget 1: feed takes it; detail needs 2 more -> deferred.
    await pollForm4(env, NOW, newTickBudget(1));

    const item = await env.DB.prepare(
      "SELECT status FROM items WHERE source = 'edgar_form4' AND external_id = '0009999999-26-000003'",
    ).first<{ status: string }>();
    expect(item?.status).toBe("pending_detail");
  });

  it("detail failures retry then land in the lake after 3 attempts", async () => {
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, syntheticFeed("4", 4));
    fetchMock.get(SEC).intercept({ path: `${dirOf(4)}/index.json` }).reply(503, "down").times(3);
    await pollForm4(env, NOW);

    let item = await env.DB.prepare(
      "SELECT status, payload FROM items WHERE external_id = '0009999999-26-000004'",
    ).first<{ status: string; payload: string }>();
    expect(item?.status).toBe("pending_detail");
    expect((JSON.parse(item!.payload) as { attempts: number }).attempts).toBe(1);

    for (const _ of [2, 3]) {
      fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(304, "");
      await pollForm4(env, NOW);
    }
    item = await env.DB.prepare(
      "SELECT status, payload FROM items WHERE external_id = '0009999999-26-000004'",
    ).first<{ status: string; payload: string }>();
    expect(item?.status).toBe("logged");
    expect((JSON.parse(item!.payload) as { attempts: number }).attempts).toBe(3);

    const state = await getSourceState(env.DB, "edgar_form4");
    expect(state.consecutiveFailures).toBe(0); // feed itself stayed healthy
  });

  it("cluster item created during detail flows out through the drain with its own archetype", async () => {
    // Two existing buyers this week; the polled filing is the third.
    await seedTrade({ issuerCik: "0000000099", ticker: "ISCO", insiderCik: "201", insiderName: "Early Bird" });
    await seedTrade({ issuerCik: "0000000099", ticker: "ISCO", insiderCik: "202", insiderName: "Second Bird" });

    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, syntheticFeed("4", 5));
    fetchMock
      .get(SEC)
      .intercept({ path: `${dirOf(5)}/index.json` })
      .reply(200, JSON.stringify({ directory: { item: [{ name: "ownership.xml" }] } }));
    fetchMock.get(SEC).intercept({ path: `${dirOf(5)}/ownership.xml` }).reply(200, buyXml);

    const s0 = SEND.calls.length;
    await pollForm4(env, NOW);

    // Single-filing notification + cluster notification both drained.
    expect(SEND.calls.length).toBe(s0 + 2);
    const clusterRow = await env.DB.prepare(
      "SELECT q.archetype, q.state, i.payload FROM queue q JOIN items i ON i.id = q.item_id WHERE i.source = ?1",
    )
      .bind(CLUSTER_SOURCE)
      .first<{ archetype: string; state: string; payload: string }>();
    expect(clusterRow?.archetype).toBe("INSIDER_CLUSTER");
    expect(clusterRow?.state).toBe("pending");
    expect((JSON.parse(clusterRow!.payload) as { factLine: string }).factLine).toContain("3 insiders bought $ISCO");
  });
});

describe("cashtags: every ticker carries $, and nothing else does", () => {
  it("a real ticker is prefixed", () => {
    const doc = {
      documentType: "4", issuerCik: "0001516513", issuerName: "Doximity, Inc.", ticker: "DOCS",
      owners: [{ cik: "1", name: "Jane Doe", isDirector: false, isOfficer: true, isTenPercent: false, officerTitle: "CEO" }],
      nonDerivative: [txn({ code: "P", shares: 50_000, price: 12.34 })],
      derivativeCount: 0,
    };
    expect(draftForm4(doc, totalsFor(doc.nonDerivative))).toContain("$DOCS");
  });

  it("A COMPANY NAME NEVER TAKES A $, which is the whole risk of this change", () => {
    // draftForm4 resolves its symbol as `ticker ?? issuerName`. Prefixing the
    // resolved value would print "$Doximity, Inc." — a cashtag for a symbol
    // that does not exist, invented by us, in copy-ready text. That is the
    // fabrication class, reached by a formatting change.
    const doc = {
      documentType: "4", issuerCik: "0001516513", issuerName: "Doximity, Inc.", ticker: null,
      owners: [{ cik: "1", name: "Jane Doe", isDirector: false, isOfficer: true, isTenPercent: false, officerTitle: "CEO" }],
      nonDerivative: [txn({ code: "P", shares: 50_000, price: 12.34 })],
      derivativeCount: 0,
    };
    const d = draftForm4(doc, totalsFor(doc.nonDerivative));
    expect(d).toContain("Doximity, Inc.");
    expect(d).not.toContain("$Doximity");
  });

  it("the $ never lands on a dollar figure or anything else already in the line", () => {
    const doc = {
      documentType: "4", issuerCik: "1", issuerName: "Acme Corp", ticker: "ACME",
      owners: [{ cik: "1", name: "Jane Doe", isDirector: true, isOfficer: false, isTenPercent: false, officerTitle: null }],
      nonDerivative: [txn({ code: "P", shares: 1_000, price: 10 })],
      derivativeCount: 0,
    };
    const d = draftForm4(doc, totalsFor(doc.nonDerivative));
    // Exactly one cashtag; the money figures keep their own $ and gain nothing.
    expect([...d.matchAll(/\$[A-Z]{1,5}\b/g)].map((m) => m[0])).toEqual(["$ACME"]);
  });
});
