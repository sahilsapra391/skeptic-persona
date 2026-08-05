import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import BRK_Q4_TBL from "./fixtures/13f-brk-q4-2025-infotable.xml.fixture?raw";
import BRK_Q4_PRI from "./fixtures/13f-brk-q4-2025-primary.xml.fixture?raw";
import BRK_Q1_TBL from "./fixtures/13f-brk-q1-2026-infotable.xml.fixture?raw";
import BRK_Q1_PRI from "./fixtures/13f-brk-q1-2026-primary.xml.fixture?raw";
import { parseAndStore13f, parseInfotable, type Holding13f } from "../src/ingesters/form13f";
import { computeDiff, runDiffFor, snapshotHoldings } from "../src/ingesters/form13fDiff";

// Fixtures are LIVE captures (2026-08-04) of Berkshire Hathaway's two
// backfill quarters — the plan's own backfill scope, driven as real data:
//   Q4-2025: acc 0001193125-26-054580, period 12-31-2025, declared 274,160,086,701
//   Q1-2026: acc 0001193125-26-226661, period 03-31-2026, declared 263,095,703,570

const NOW = new Date("2026-08-04T20:00:00.000Z");
const CIK = "1067983";

function mk(cusip: string, value: number, shares: number, putCall = ""): Holding13f {
  return {
    cusip, putCall, issuer: `ISSUER ${cusip}`, cls: "COM", valueUsd: value, shares,
    shPrnType: "SH", discretion: "SOLE", votingSole: shares, votingShared: 0, votingNone: 0,
  };
}

describe("computeDiff — statuses and derived fields (model never does arithmetic)", () => {
  it("partitions NEW / EXIT / ADD / TRIM / UNCHANGED and pre-computes every figure", () => {
    const prev = [mk("AAAAAAAA1", 1000, 100), mk("BBBBBBBB1", 2000, 200), mk("CCCCCCCC1", 3000, 300), mk("DDDDDDDD1", 4000, 400)];
    const curr = [mk("BBBBBBBB1", 2500, 250), mk("CCCCCCCC1", 1500, 150), mk("DDDDDDDD1", 4400, 400), mk("EEEEEEEE1", 500, 50)];
    const rows = computeDiff(prev, curr);
    const by = Object.fromEntries(rows.map((r) => [r.cusip, r]));

    expect(by["EEEEEEEE1"]!.status).toBe("NEW");
    expect(by["EEEEEEEE1"]!.prevShares).toBeNull();
    expect(by["EEEEEEEE1"]!.qoqShareDeltaPct).toBeNull(); // delta over zero base is NOT a number

    expect(by["AAAAAAAA1"]!.status).toBe("EXIT");
    expect(by["AAAAAAAA1"]!.valueUsd).toBeNull();
    expect(by["AAAAAAAA1"]!.prevValueUsd).toBe(1000); // EXIT carries what was held
    expect(by["AAAAAAAA1"]!.qoqValueDeltaUsd).toBe(-1000);

    expect(by["BBBBBBBB1"]!.status).toBe("ADD");
    expect(by["BBBBBBBB1"]!.qoqShareDelta).toBe(50);
    expect(by["BBBBBBBB1"]!.qoqShareDeltaPct).toBe(25);

    expect(by["CCCCCCCC1"]!.status).toBe("TRIM");
    expect(by["CCCCCCCC1"]!.qoqShareDelta).toBe(-150);
    expect(by["CCCCCCCC1"]!.qoqShareDeltaPct).toBe(-50);

    // Shares equal, value moved (price): still UNCHANGED — position status is
    // about the HOLDING, and value drift inside a quarter is the market's.
    expect(by["DDDDDDDD1"]!.status).toBe("UNCHANGED");

    const total = 2500 + 1500 + 4400 + 500;
    expect(by["EEEEEEEE1"]!.pctOfPortfolio).toBe(Math.round((500 / total) * 10000) / 100);
  });

  it("a put and a share position on one cusip never diff against each other", () => {
    const prev = [mk("AAAAAAAA1", 1000, 100)];
    const curr = [mk("AAAAAAAA1", 1000, 100, "Put")];
    const rows = computeDiff(prev, curr);
    expect(rows.find((r) => r.putCall === "Put")!.status).toBe("NEW");
    expect(rows.find((r) => r.putCall === "")!.status).toBe("EXIT");
  });
});

describe("the REAL backfill pair: Berkshire Q4-2025 -> Q1-2026", () => {
  it("reproduces the measured diff exactly", () => {
    const q4 = parseInfotable(BRK_Q4_TBL as string);
    const q1 = parseInfotable(BRK_Q1_TBL as string);
    // Parsed totals match the filers' own declared totals to the dollar.
    expect(q4.reduce((n, h) => n + h.valueUsd, 0)).toBe(274160086701);
    expect(q1.reduce((n, h) => n + h.valueUsd, 0)).toBe(263095703570);
    expect(q4.length).toBe(42);
    expect(q1.length).toBe(29);

    const rows = computeDiff(q4, q1);
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    // Measured 2026-08-04 against the live filings; these are the lane's
    // acceptance numbers, not guesses.
    expect(count("NEW")).toBe(3);
    expect(count("EXIT")).toBe(16);
    expect(count("ADD")).toBe(4);
    expect(count("TRIM")).toBe(6);
    expect(count("UNCHANGED")).toBe(16);

    // A real, checkable exit: AMAZON (023135106) reported in Q4, absent in Q1.
    const amzn = rows.find((r) => r.cusip === "023135106")!;
    expect(amzn.status).toBe("EXIT");
    expect(amzn.prevValueUsd).toBeGreaterThan(0);

    // No NaN anywhere — every numeric field is a finished number or NULL.
    for (const r of rows) {
      for (const v of [r.valueUsd, r.shares, r.prevValueUsd, r.prevShares, r.pctOfPortfolio, r.qoqShareDelta, r.qoqShareDeltaPct, r.qoqValueDeltaUsd]) {
        if (v !== null) expect(Number.isFinite(v), `${r.cusip} ${r.status}`).toBe(true);
      }
    }
  });
});

async function storeFiling(accession: string, form: string, filedAt: string, primary: string, table: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO filings_13f (accession, cik, manager_name, form, filed_at, status, created_at)
     VALUES (?1, ?2, 'BERKSHIRE HATHAWAY INC', ?3, ?4, 'pending_parse', ?5)`,
  ).bind(accession, CIK, form, filedAt, NOW.toISOString()).run();
  const row = await env.DB.prepare(`SELECT id FROM filings_13f WHERE accession = ?1`).bind(accession).first<{ id: number }>();
  const status = await parseAndStore13f(env as never, { id: row!.id, cik: CIK, accession }, primary, table, table.length, NOW);
  expect(status).toBe("parsed");
}

describe("runDiffFor + snapshotHoldings against stored filings", () => {
  beforeEach(async () => {
    for (const t of ["diffs_13f", "holdings_13f", "filings_13f"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await env.DB.prepare(`UPDATE managers_13f SET coverage_start = NULL`).run();
  });

  it("one snapshot computes nothing — a photo is not a comparison", async () => {
    await storeFiling("0001193125-26-054580", "13F-HR", "2026-02-17T00:00:00.000Z", BRK_Q4_PRI as string, BRK_Q4_TBL as string);
    await runDiffFor(env as never, CIK, NOW);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM diffs_13f`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("two held quarters diff end to end, and coverage_start records first observation", async () => {
    await storeFiling("0001193125-26-054580", "13F-HR", "2026-02-17T00:00:00.000Z", BRK_Q4_PRI as string, BRK_Q4_TBL as string);
    await storeFiling("0001193125-26-226661", "13F-HR", "2026-05-15T00:00:00.000Z", BRK_Q1_PRI as string, BRK_Q1_TBL as string);
    await runDiffFor(env as never, CIK, NOW);

    const agg = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM diffs_13f WHERE cik = ?1 AND period = '2026-03-31' GROUP BY status`,
    ).bind(CIK).all<{ status: string; n: number }>();
    const m = Object.fromEntries(agg.results.map((r) => [r.status, r.n]));
    expect(m).toEqual({ NEW: 3, EXIT: 16, ADD: 4, TRIM: 6, UNCHANGED: 16 });

    const prevP = await env.DB.prepare(
      `SELECT DISTINCT prev_period FROM diffs_13f WHERE cik = ?1 AND period = '2026-03-31'`,
    ).bind(CIK).first<{ prev_period: string }>();
    expect(prevP?.prev_period).toBe("2025-12-31");

    // coverage_start = when WE first held a filing (observation), set once.
    const cov = await env.DB.prepare(`SELECT coverage_start FROM managers_13f WHERE cik = ?1`).bind(CIK).first<{ coverage_start: string }>();
    expect(cov?.coverage_start).toBe(NOW.toISOString());
  });

  it("a RESTATEMENT amendment replaces the snapshot and the diff moves with it", async () => {
    await storeFiling("0001193125-26-054580", "13F-HR", "2026-02-17T00:00:00.000Z", BRK_Q4_PRI as string, BRK_Q4_TBL as string);
    await storeFiling("0001193125-26-226661", "13F-HR", "2026-05-15T00:00:00.000Z", BRK_Q1_PRI as string, BRK_Q1_TBL as string);
    await runDiffFor(env as never, CIK, NOW);

    // Amend Q1 with a RESTATEMENT that holds ONLY Apple. The snapshot must
    // become the amendment, so the recomputed diff exits everything else.
    const restated = `<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
      <infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><titleOfClass>COM</titleOfClass>
      <cusip>037833100</cusip><value>60000000000</value>
      <shrsOrPrnAmt><sshPrnamt>300000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
      <investmentDiscretion>SOLE</investmentDiscretion>
      <votingAuthority><Sole>300000000</Sole><Shared>0</Shared><None>0</None></votingAuthority></infoTable>
    </informationTable>`;
    const priA = (BRK_Q1_PRI as string)
      .replace("<submissionType>13F-HR</submissionType>", "<submissionType>13F-HR/A</submissionType>")
      .replace("</periodOfReport>", "</periodOfReport><amendmentInfo><amendmentType>RESTATEMENT</amendmentType></amendmentInfo>")
      .replace(/<tableValueTotal>[^<]+<\/tableValueTotal>/, "<tableValueTotal>60000000000</tableValueTotal>")
      .replace(/<tableEntryTotal>[^<]+<\/tableEntryTotal>/, "<tableEntryTotal>1</tableEntryTotal>");
    await storeFiling("0001193125-26-999999", "13F-HR/A", "2026-06-01T00:00:00.000Z", priA, restated);

    const snap = await snapshotHoldings(env as never, CIK, "2026-03-31");
    expect(snap!.length).toBe(1);
    expect(snap![0]!.cusip).toBe("037833100");

    await runDiffFor(env as never, CIK, NOW);
    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM diffs_13f WHERE cik = ?1 AND period = '2026-03-31' AND status = 'EXIT'`,
    ).bind(CIK).first<{ n: number }>();
    // Every Q4 position except Apple is now an EXIT against the restated Q1.
    expect(after?.n).toBe(41);
  });

  it("a NEW HOLDINGS amendment merges — the confidential-treatment reveal", async () => {
    await storeFiling("0001193125-26-054580", "13F-HR", "2026-02-17T00:00:00.000Z", BRK_Q4_PRI as string, BRK_Q4_TBL as string);
    const reveal = `<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
      <infoTable><nameOfIssuer>SECRET CORP</nameOfIssuer><titleOfClass>COM</titleOfClass>
      <cusip>99999ZZ99</cusip><value>5000000000</value>
      <shrsOrPrnAmt><sshPrnamt>10000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
      <investmentDiscretion>SOLE</investmentDiscretion>
      <votingAuthority><Sole>10000000</Sole><Shared>0</Shared><None>0</None></votingAuthority></infoTable>
    </informationTable>`;
    const priA = (BRK_Q4_PRI as string)
      .replace("<submissionType>13F-HR</submissionType>", "<submissionType>13F-HR/A</submissionType>")
      .replace("</periodOfReport>", "</periodOfReport><amendmentInfo><amendmentType>NEW HOLDINGS</amendmentType></amendmentInfo>")
      .replace(/<tableValueTotal>[^<]+<\/tableValueTotal>/, "<tableValueTotal>5000000000</tableValueTotal>")
      .replace(/<tableEntryTotal>[^<]+<\/tableEntryTotal>/, "<tableEntryTotal>1</tableEntryTotal>");
    await storeFiling("0001193125-26-888888", "13F-HR/A", "2026-03-01T00:00:00.000Z", priA, reveal);

    const snap = await snapshotHoldings(env as never, CIK, "2025-12-31");
    expect(snap!.length).toBe(43); // 42 original + the revealed position
    expect(snap!.some((h) => h.cusip === "99999ZZ99")).toBe(true);
  });
});

describe("the backfill relay route — same parser, courier-delivered bytes", () => {
  beforeEach(async () => {
    for (const t of ["diffs_13f", "holdings_13f", "filings_13f"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  async function post(body: unknown): Promise<Response> {
    const { handleIngestRelay } = await import("../src/ingestRelay");
    return handleIngestRelay(
      new Request("https://worker.test/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Ingest-Secret": "test-ingest-secret" },
        body: JSON.stringify(body),
      }),
      env as never,
      NOW,
    );
  }

  it("stores, parses, and diffs a courier-delivered filing pair end to end", async () => {
    const mkBody = (acc: string, filed: string, pri: string, tbl: string) =>
      JSON.stringify({ cik: CIK, accession: acc, form: "13F-HR", filed_at: filed, primary_doc: pri, infotable: tbl });

    const r1 = await post({ source: "13f_backfill", body: mkBody("0001193125-26-054580", "2026-02-17T00:00:00.000Z", BRK_Q4_PRI as string, BRK_Q4_TBL as string) });
    expect(r1.status).toBe(200);
    const r2 = await post({ source: "13f_backfill", body: mkBody("0001193125-26-226661", "2026-05-15T00:00:00.000Z", BRK_Q1_PRI as string, BRK_Q1_TBL as string) });
    expect(r2.status).toBe(200);

    const parsed = await env.DB.prepare(`SELECT COUNT(*) AS n FROM filings_13f WHERE status = 'parsed'`).first<{ n: number }>();
    expect(parsed?.n).toBe(2);
    const diffs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM diffs_13f WHERE period = '2026-03-31'`).first<{ n: number }>();
    expect(diffs?.n).toBe(29 + 16); // current positions + exits

    // Courier retry is a no-op, never a re-parse or a duplicate.
    const r3 = await post({ source: "13f_backfill", body: mkBody("0001193125-26-226661", "2026-05-15T00:00:00.000Z", BRK_Q1_PRI as string, BRK_Q1_TBL as string) });
    expect(r3.status).toBe(200);
    const holdings = await env.DB.prepare(`SELECT COUNT(*) AS n FROM holdings_13f`).first<{ n: number }>();
    expect(holdings?.n).toBe(42 + 29);
  });

  it("rejects a non-13F form rather than storing it", async () => {
    // A VALID, parseable 13F body labelled 10-K: without the form gate this
    // would store cleanly (the first version used junk XML, so the reject
    // fired on the parse and the mutation that deleted the gate stayed
    // green — the reject has to be attributable to the GATE alone).
    const res = await post({
      source: "13f_backfill",
      body: JSON.stringify({
        cik: CIK, accession: "0001193125-26-777777", form: "10-K",
        filed_at: "2026-01-01T00:00:00.000Z",
        primary_doc: BRK_Q4_PRI as string, infotable: BRK_Q4_TBL as string,
      }),
    });
    expect(res.status).not.toBe(200);
    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM filings_13f WHERE accession = '0001193125-26-777777'`,
    ).first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });
});
