import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insiderLakeContextFor, lakeContextFields, notice144LinkFor } from "../src/pipeline/insiderLake";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const SOURCE = "edgar_form4";

async function seedTrade(o: {
  itemId: number;
  insider?: string;
  issuer?: string;
  side?: string;
  code?: string;
  shares?: number;
  date: string;
  amendment?: number;
}) {
  // insider_trades.item_id is a FOREIGN KEY into items, so the parent row has
  // to exist for the seed to be a realistic one.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO items (id, dedup_key, source, external_id, category, fetched_at, source_url, payload, score, status)
     VALUES (?1, 'k' || ?1, 'edgar_form4', 'e' || ?1, 'filing', '2026-08-01T00:00:00.000Z', 'https://sec.gov/x', '{}', 50, 'logged')`,
  )
    .bind(o.itemId)
    .run();
  await env.DB.prepare(
    `INSERT INTO insider_trades
       (item_id, issuer_cik, ticker, insider_cik, insider_name, is_officer, is_director,
        officer_title, side, code, shares, price, shares_after, pct_change, transaction_date, is_amendment, txn_index)
     VALUES (?1, ?2, 'X', ?3, 'Someone', 0, 1, NULL, ?4, ?5, ?6, 10, 100, NULL, ?7, ?8, ?9)`,
  )
    .bind(
      o.itemId,
      o.issuer ?? "0000001",
      o.insider ?? "0000999",
      o.side ?? "sell",
      o.code ?? "S",
      o.shares ?? 100,
      o.date,
      o.amendment ?? 0,
      o.itemId,
    )
    .run();
}

/** Open coverage at a chosen point, the way recordFacts would. */
async function seedCoverage(observedFrom: string) {
  await env.DB.prepare(
    `INSERT INTO lookback_coverage (source, metric, observed_from, updated_at)
     VALUES (?1, '*', ?2, ?2) ON CONFLICT(source) DO UPDATE SET observed_from = ?2`,
  )
    .bind(SOURCE, observedFrom)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM insider_trades`).run();
  await env.DB.prepare(`DELETE FROM items WHERE source = 'edgar_form4'`).run();
  await env.DB.prepare(`DELETE FROM lookback_coverage WHERE source = ?1`).bind(SOURCE).run();
});

describe("insiderLakeContextFor: the coverage guard", () => {
  // THE CASE THAT MATTERS TODAY. We opened on edgar_form4 two weeks ago and
  // the lake still holds one straggling 2024 row, so the data exists to
  // compute a year-to-date count and we must not state one.
  it("suppresses every count when the window is longer than coverage", async () => {
    await seedCoverage("2026-07-27T00:00:00.000Z"); // 14 days
    for (const d of ["2026-02-03", "2026-05-06", "2026-07-30"]) {
      await seedTrade({ itemId: Number(d.replace(/-/g, "").slice(4)), date: d });
    }
    const ctx = await insiderLakeContextFor(
      env.DB,
      { insiderCik: "0000999", issuerCik: "0000001", since: "2026-01-01T00:00:00.000Z", source: SOURCE },
      NOW,
    );
    expect(ctx.covered).toBe(false);
    expect(ctx.priorSales).toBeNull();
    expect(ctx.activeMonths).toBeNull();
    expect(ctx.coverageDays).toBe(14);
    expect(ctx.windowDays).toBe(221);

    // And the payload keys are ABSENT, so no gate can match on them.
    const f = lakeContextFields(ctx);
    expect("priorSales" in f).toBe(false);
    expect("saleOccurrence" in f).toBe(false);
    // Coverage still rides along, so the ledger can say why.
    expect(f.lookbackCoverageDays).toBe(14);
    expect(f.lookbackWindowDays).toBe(221);
  });

  it("suppresses when no coverage row exists at all", async () => {
    await seedTrade({ itemId: 1, date: "2026-08-01" });
    const ctx = await insiderLakeContextFor(
      env.DB,
      { insiderCik: "0000999", issuerCik: "0000001", since: "2026-08-01T00:00:00.000Z", source: SOURCE },
      NOW,
    );
    expect(ctx.coverageDays).toBeNull();
    expect(ctx.covered).toBe(false);
    expect(ctx.priorSales).toBeNull();
  });

  it("populates every count once the window IS covered", async () => {
    await seedCoverage("2026-01-01T00:00:00.000Z");
    await seedTrade({ itemId: 1, date: "2026-07-02", shares: 500 });
    await seedTrade({ itemId: 2, date: "2026-07-20", shares: 300 });
    await seedTrade({ itemId: 3, date: "2026-08-04", shares: 200 });
    const ctx = await insiderLakeContextFor(
      env.DB,
      { insiderCik: "0000999", issuerCik: "0000001", since: "2026-07-01T00:00:00.000Z", source: SOURCE },
      NOW,
    );
    expect(ctx.covered).toBe(true);
    expect(ctx.priorSales).toBe(3);
    expect(ctx.priorSaleShares).toBe(1000);
    expect(ctx.lastSaleDate).toBe("2026-08-04");
    expect(ctx.activeMonths).toBe(2);
    // Three priors makes the filing being rendered the fourth.
    expect(lakeContextFields(ctx).saleOccurrence).toBe(4);
  });

  it("excludes the item being rendered so it cannot count itself", async () => {
    await seedCoverage("2026-01-01T00:00:00.000Z");
    await seedTrade({ itemId: 7, date: "2026-08-01" });
    await seedTrade({ itemId: 8, date: "2026-08-02" });
    const ctx = await insiderLakeContextFor(
      env.DB,
      {
        insiderCik: "0000999",
        issuerCik: "0000001",
        since: "2026-07-01T00:00:00.000Z",
        excludeItemId: 8,
        source: SOURCE,
      },
      NOW,
    );
    expect(ctx.priorSales).toBe(1);
  });

  it("counts only sales, and only this insider at this issuer", async () => {
    await seedCoverage("2026-01-01T00:00:00.000Z");
    await seedTrade({ itemId: 1, date: "2026-08-01" });
    await seedTrade({ itemId: 2, date: "2026-08-01", side: "buy", code: "P" });
    await seedTrade({ itemId: 3, date: "2026-08-01", side: "other", code: "M" });
    await seedTrade({ itemId: 4, date: "2026-08-01", insider: "0000888" });
    await seedTrade({ itemId: 5, date: "2026-08-01", issuer: "0000002" });
    await seedTrade({ itemId: 6, date: "2026-08-01", amendment: 1 });
    const ctx = await insiderLakeContextFor(
      env.DB,
      { insiderCik: "0000999", issuerCik: "0000001", since: "2026-07-01T00:00:00.000Z", source: SOURCE },
      NOW,
    );
    expect(ctx.priorSales).toBe(1);
  });
});

describe("notice144LinkFor", () => {
  // Verified against the real pair: a Form 144's <cik> is the seller's, the
  // same identity Form 4 reports, so (insider_cik, issuer_cik) joins them.
  it("finds the seller's Form 4 sales at the same issuer", async () => {
    await seedTrade({ itemId: 1, insider: "0001799461", issuer: "0000866729", date: "2026-08-05", shares: 20488 });
    await seedTrade({ itemId: 2, insider: "0001799461", issuer: "0000866729", date: "2026-08-06", shares: 5139 });
    const link = await notice144LinkFor(env.DB, { sellerCik: "0001799461", issuerCik: "0000866729" });
    expect(link).toEqual({
      priorForm4Sales: 2,
      priorForm4Shares: 20488 + 5139,
      lastForm4SaleDate: "2026-08-06",
    });
  });

  // Absent, not zero: "no prior sales" and "we have not been watching long
  // enough" are different claims and only one is ours to make.
  it("returns null rather than a zero when we hold nothing", async () => {
    expect(await notice144LinkFor(env.DB, { sellerCik: "0001799461", issuerCik: "0000866729" })).toBeNull();
  });

  // NOT coverage-guarded on purpose: it reports rows held, not a window count.
  it("reports held rows with no coverage row present", async () => {
    await seedTrade({ itemId: 1, insider: "0001799461", issuer: "0000866729", date: "2026-08-05" });
    const link = await notice144LinkFor(env.DB, { sellerCik: "0001799461", issuerCik: "0000866729" });
    expect(link?.priorForm4Sales).toBe(1);
  });
});
