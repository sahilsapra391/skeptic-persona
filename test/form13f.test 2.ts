import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import FEED from "./fixtures/13f-current.atom.fixture?raw";
import INFOTABLE from "./fixtures/13f-infotable-meridian.xml.fixture?raw";
import PRIMARY from "./fixtures/13f-primary-meridian.xml.fixture?raw";
import BATCH1 from "./fixtures/openfigi-batch1.json.fixture?raw";
import {
  ALLOWED_FORMS,
  normalizePeriod,
  parse13fFeed,
  parseInfotable,
  pollForm13f,
  sanityCheck,
  SANITY_MAX_POSITION_USD_DEFAULT,
  EDGAR_13F_FEED,
} from "../src/ingesters/form13f";
import { newTickBudget } from "../src/lib/budget";

// Fixtures are LIVE captures, 2026-08-04, current Q2-2026 window:
//   feed      getcurrent type=13F count=40 (33 HR + 7 NT at capture)
//   infotable MERIDIAN MANAGEMENT CO 13F-HR, acc 0000806097-26-000004,
//             112 rows, declared tableValueTotal 445550203 (whole USD)
//   primary   same filing; periodOfReport "06-30-2026" (MM-DD-YYYY dialect)

const NOW = new Date("2026-08-04T18:00:00.000Z");

describe("parse13fFeed", () => {
  it("parses the live feed: forms filtered to the allowed set, accessions unique", () => {
    const entries = parse13fFeed(FEED as string);
    expect(entries.length).toBeGreaterThan(30);
    expect(new Set(entries.map((e) => e.accession)).size).toBe(entries.length);
    for (const e of entries) {
      expect(ALLOWED_FORMS.has(e.form), e.form).toBe(true);
      expect(e.cik).toMatch(/^\d+$/);
      expect(e.cik).not.toMatch(/^0/); // left-padding stripped
      expect(e.filedIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(e.dirUrl).not.toMatch(/-index\.htm/);
    }
    const forms = new Set(entries.map((e) => e.form));
    expect(forms.has("13F-HR")).toBe(true);
    expect(forms.has("13F-NT")).toBe(true);
  });
});

describe("normalizePeriod — the fifth date dialect", () => {
  it("normalizes MM-DD-YYYY (verified live) and passes ISO through", () => {
    expect(normalizePeriod("06-30-2026")).toBe("2026-06-30");
    expect(normalizePeriod("2026-06-30")).toBe("2026-06-30");
  });
  it("never guesses at anything else", () => {
    expect(normalizePeriod("30/06/2026")).toBeNull();
    expect(normalizePeriod("June 30, 2026")).toBeNull();
    expect(normalizePeriod("")).toBeNull();
    expect(normalizePeriod(null)).toBeNull();
  });
});

describe("parseInfotable on the real MERIDIAN filing", () => {
  const holdings = parseInfotable(INFOTABLE as string);

  it("aggregates lots: ALPHABET's two rows become one position", () => {
    // Live shape: 19,422 sh and 43 sh in separate discretion lots.
    const goog = holdings.filter((h) => h.cusip === "02079K107");
    expect(goog.length).toBe(1);
    expect(goog[0]!.shares).toBe(19465);
    expect(goog[0]!.valueUsd).toBe(6862375 + 15193);
  });

  it("sums to the filer's own declared total (whole dollars, not thousands)", () => {
    const total = holdings.reduce((n, h) => n + h.valueUsd, 0);
    expect(total).toBe(445550203); // primary_doc tableValueTotal, exact
  });

  it("carries voting and never invents putCall", () => {
    for (const h of holdings) expect(["", "Put", "Call"]).toContain(h.putCall);
    const abnb = holdings.find((h) => h.cusip === "009066101")!;
    expect(abnb.votingNone).toBe(9092);
    expect(abnb.shPrnType).toBe("SH");
  });

  it("parses namespaced variants and put/call rows", () => {
    const xml = `<?xml version="1.0"?>
      <n1:informationTable xmlns:n1="http://www.sec.gov/edgar/document/thirteenf/informationtable">
        <n1:infoTable>
          <n1:nameOfIssuer>EXAMPLE CORP</n1:nameOfIssuer>
          <n1:titleOfClass>COM</n1:titleOfClass>
          <n1:cusip>12345A108</n1:cusip>
          <n1:value>1000000</n1:value>
          <n1:shrsOrPrnAmt><n1:sshPrnamt>5000</n1:sshPrnamt><n1:sshPrnamtType>SH</n1:sshPrnamtType></n1:shrsOrPrnAmt>
          <n1:putCall>Put</n1:putCall>
          <n1:investmentDiscretion>SOLE</n1:investmentDiscretion>
          <n1:votingAuthority><n1:Sole>5000</n1:Sole><n1:Shared>0</n1:Shared><n1:None>0</n1:None></n1:votingAuthority>
        </n1:infoTable>
      </n1:informationTable>`;
    const rows = parseInfotable(xml);
    expect(rows.length).toBe(1);
    expect(rows[0]!.putCall).toBe("Put");
    expect(rows[0]!.cusip).toBe("12345A108");
  });

  it("keeps Put and Call rows on one cusip as separate positions", () => {
    const mk = (pc: string) => `
      <infoTable><nameOfIssuer>X</nameOfIssuer><titleOfClass>COM</titleOfClass>
      <cusip>12345A108</cusip><value>100</value>
      <shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
      ${pc}<investmentDiscretion>SOLE</investmentDiscretion>
      <votingAuthority><Sole>0</Sole><Shared>0</Shared><None>10</None></votingAuthority></infoTable>`;
    const rows = parseInfotable(`<informationTable>${mk("<putCall>Put</putCall>")}${mk("<putCall>Call</putCall>")}${mk("")}</informationTable>`);
    expect(rows.map((r) => r.putCall).sort()).toEqual(["", "Call", "Put"]);
  });

  it("drops malformed rows rather than claiming them", () => {
    const rows = parseInfotable(`<informationTable><infoTable>
      <nameOfIssuer>BAD</nameOfIssuer><cusip>SHORT</cusip><value>1</value>
      <shrsOrPrnAmt><sshPrnamt>1</sshPrnamt></shrsOrPrnAmt></infoTable></informationTable>`);
    expect(rows).toEqual([]);
  });
});

describe("sanityCheck — the units defense", () => {
  const good = parseInfotable(INFOTABLE as string);

  it("passes the real filing against its declared total", () => {
    const v = sanityCheck(good, 445550203, env as never);
    expect(v.ok).toBe(true);
  });

  it("quarantines a single position above the ceiling (synthetic oversize)", () => {
    const poisoned = [...good];
    poisoned[0] = { ...poisoned[0]!, valueUsd: SANITY_MAX_POSITION_USD_DEFAULT + 1 };
    const v = sanityCheck(poisoned, null, env as never);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("position_above_ceiling");
  });

  it("quarantines when our parse disagrees with the filer's declared total", () => {
    const v = sanityCheck(good, 445550203 * 2, env as never);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("total_mismatch_vs_declared");
  });

  it("quarantines thousands-style values via implied price, at any portfolio size", () => {
    // A filer reporting in thousands against the whole-dollar rule: every
    // equity row's value/shares implies a share price ~1/1000 of reality.
    // AIRBNB at $0.14, ALPHABET at $0.35 — no ceiling or floor catches this
    // for a big-enough portfolio; implied price does.
    // Synthetic rather than derived from MERIDIAN: dividing the real $445M
    // portfolio by 1000 lands UNDER the $50M floor, so the floor fires first
    // and this test would pass without the implied-price gate existing. A
    // $100M-total portfolio with thousands-style values is what only the
    // implied-price gate can catch.
    const inThousands = Array.from({ length: 10 }, (_, i) => ({
      cusip: `TEST${String(i).padStart(4, "0")}A`, putCall: "", issuer: `ISSUER ${i}`, cls: "COM",
      valueUsd: 10_000_000, shares: 50_000_000, shPrnType: "SH", discretion: "SOLE",
      votingSole: 0, votingShared: 0, votingNone: 0,
    }));
    const v = sanityCheck(inThousands, 100_000_000, env as never);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("implied_price_out_of_range");
  });

  it("quarantines an empty table", () => {
    expect(sanityCheck([], null, env as never).reason).toBe("empty_table");
  });
});

describe("pollForm13f end to end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM filings_13f").run();
    await env.DB.prepare("DELETE FROM holdings_13f").run();
    await env.DB.prepare("DELETE FROM managers_13f").run();
    await env.DB.prepare("DELETE FROM cusip_map").run();
  });

  const SEC = "https://www.sec.gov";
  const FEED_PATH = EDGAR_13F_FEED.replace(SEC, "");

  function mockFeed(): void {
    fetchMock.get(SEC).intercept({ path: FEED_PATH }).reply(200, FEED as string);
    // The pager fetches page 2 whenever page 1 was entirely new; serving the
    // same fixture there makes every entry a dup, which is the stop signal.
    fetchMock.get(SEC).intercept({ path: `${FEED_PATH}&start=100` }).reply(200, FEED as string);
  }

  it("records metadata for every filing; NT rows are linked, never parsed", async () => {
    mockFeed();
    await pollForm13f(env as never, NOW, newTickBudget());
    const byStatus = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM filings_13f GROUP BY status`,
    ).all<{ status: string; n: number }>();
    const m = Object.fromEntries(byStatus.results.map((r) => [r.status, r.n]));
    expect(m["metadata"]).toBeGreaterThan(25);
    expect(m["nt_linked"]).toBeGreaterThan(3);
    expect(m["pending_parse"]).toBeUndefined(); // watchlist is empty
    const holdings = await env.DB.prepare(`SELECT COUNT(*) AS n FROM holdings_13f`).first<{ n: number }>();
    expect(holdings?.n).toBe(0);
  });

  it("a second poll inserts nothing (dedup on accession)", async () => {
    mockFeed();
    await pollForm13f(env as never, NOW, newTickBudget());
    const first = await env.DB.prepare(`SELECT COUNT(*) AS n FROM filings_13f`).first<{ n: number }>();
    mockFeed();
    await pollForm13f(env as never, NOW, newTickBudget());
    const second = await env.DB.prepare(`SELECT COUNT(*) AS n FROM filings_13f`).first<{ n: number }>();
    expect(second?.n).toBe(first?.n);
  });

  it("watchlist filing parses end to end: index -> primary -> infotable -> holdings", async () => {
    // MERIDIAN (cik 806097) is in the live feed; put it on the watchlist.
    await env.DB.prepare(
      `INSERT INTO managers_13f (cik, name, tier, added_at) VALUES ('806097', 'MERIDIAN MANAGEMENT CO', 2, ?1)`,
    ).bind(NOW.toISOString()).run();
    mockFeed();
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/index.json" })
      .reply(200, JSON.stringify({
        directory: { item: [
          { name: "13f0626table.xml", size: 55485 },
          { name: "primary_doc.xml", size: 2258 },
        ]},
      }));
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/primary_doc.xml" })
      .reply(200, PRIMARY as string);
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/13f0626table.xml" })
      .reply(200, INFOTABLE as string);
    fetchMock
      .get("https://api.openfigi.com")
      .intercept({ path: "/v3/mapping", method: "POST" })
      .reply(200, BATCH1 as string);

    await pollForm13f(env as never, NOW, newTickBudget());

    const filing = await env.DB.prepare(
      `SELECT status, period, table_value_total, parsed_value_total, infotable_bytes
       FROM filings_13f WHERE cik = '806097'`,
    ).first<{ status: string; period: string; table_value_total: number; parsed_value_total: number; infotable_bytes: number }>();
    expect(filing?.status).toBe("parsed");
    expect(filing?.period).toBe("2026-06-30"); // MM-DD-YYYY normalized
    expect(filing?.table_value_total).toBe(445550203);
    expect(filing?.parsed_value_total).toBe(445550203);

    // The 13F-02 resolver drain fires in the same tick: mock one openFIGI
    // batch and assert the WIRING, not just the lib (deleting the drain from
    // pollForm13f must turn this red).
    const mapped = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cusip_map`).first<{ n: number }>();
    expect(mapped?.n).toBeGreaterThan(0);

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(value_usd) AS total FROM holdings_13f`,
    ).first<{ n: number; total: number }>();
    // Measured on the real filing: 112 declared infoTable rows aggregate to
    // 84 positions — a quarter of the table is lot-splitting. Fewer rows than
    // declared is the expected direction; more would mean aggregation broke.
    expect(n?.n).toBe(84);
    expect(n?.n).toBeLessThan(112); // declared tableEntryTotal
    expect(n?.total).toBe(445550203);
  });

  it("an oversized infotable defers to the heavy lane instead of parsing inline", async () => {
    await env.DB.prepare(
      `INSERT INTO managers_13f (cik, name, tier, added_at) VALUES ('806097', 'MERIDIAN', 2, ?1)`,
    ).bind(NOW.toISOString()).run();
    mockFeed();
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/index.json" })
      .reply(200, JSON.stringify({
        directory: { item: [
          { name: "huge_table.xml", size: 30_000_000 },
          { name: "primary_doc.xml", size: 2258 },
        ]},
      }));
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/primary_doc.xml" })
      .reply(200, PRIMARY as string);

    await pollForm13f(env as never, NOW, newTickBudget());
    const filing = await env.DB.prepare(
      `SELECT status, infotable_bytes FROM filings_13f WHERE cik = '806097'`,
    ).first<{ status: string; infotable_bytes: number }>();
    expect(filing?.status).toBe("deferred_heavy");
    expect(filing?.infotable_bytes).toBe(30_000_000);
    const holdings = await env.DB.prepare(`SELECT COUNT(*) AS n FROM holdings_13f`).first<{ n: number }>();
    expect(holdings?.n).toBe(0);
  });

  it("a quarantined filing writes NO holdings rows", async () => {
    await env.DB.prepare(
      `INSERT INTO managers_13f (cik, name, tier, added_at) VALUES ('806097', 'MERIDIAN', 2, ?1)`,
    ).bind(NOW.toISOString()).run();
    mockFeed();
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/index.json" })
      .reply(200, JSON.stringify({
        directory: { item: [
          { name: "13f0626table.xml", size: 55485 },
          { name: "primary_doc.xml", size: 2258 },
        ]},
      }));
    // Declared total wildly different from the table -> total_mismatch.
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/primary_doc.xml" })
      .reply(200, (PRIMARY as string).replace("<tableValueTotal>445550203</tableValueTotal>", "<tableValueTotal>999999999999</tableValueTotal>"));
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/Archives/edgar/data/806097/000080609726000004/13f0626table.xml" })
      .reply(200, INFOTABLE as string);

    await pollForm13f(env as never, NOW, newTickBudget());
    const filing = await env.DB.prepare(
      `SELECT status, quarantine_reason FROM filings_13f WHERE cik = '806097'`,
    ).first<{ status: string; quarantine_reason: string }>();
    expect(filing?.status).toBe("quarantined");
    expect(filing?.quarantine_reason).toBe("total_mismatch_vs_declared");
    const holdings = await env.DB.prepare(`SELECT COUNT(*) AS n FROM holdings_13f`).first<{ n: number }>();
    expect(holdings?.n).toBe(0);
  });
});
