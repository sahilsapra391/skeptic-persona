import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { lakeContext, MIN_COVERAGE_DAYS } from "../src/rag/context";
import { insertItem, SCORE_POSTABLE } from "../src/lib/db";

const NOW = new Date("2026-08-02T18:00:00.000Z");

/** Insert an item with an explicit fetched_at, which is what coverage means. */
async function seed(source: string, externalId: string, eventAt: string, fetchedAt: string): Promise<number> {
  const res = await insertItem(
    env.DB,
    {
      source, externalId, category: "regulatory", eventAt,
      sourceUrl: `https://example.gov/${externalId}`,
      payload: { authority: "CFTC", title: `Item ${externalId}` },
      score: SCORE_POSTABLE,
    },
    new Date(fetchedAt),
  );
  const id = res.id ?? 0;
  await env.DB.prepare(`UPDATE items SET fetched_at = ?1 WHERE id = ?2`).bind(fetchedAt, id).run();
  return id;
}

function countLine(lines: readonly string[]): string | undefined {
  return lines.find((l) => /prior .* in our lake since/.test(l));
}

describe("a corroboration count must be backed by our own coverage", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM items").run();
  });

  it("THE PRODUCTION CASE: one poll of a feed's backlog cites no count", async () => {
    // Measured 2026-08-02: all ten press_cftc_enforcement items arrived in ONE
    // poll at 17:18 on 08-01, with event dates spanning 04-23 to 07-31. The
    // lake context said "9 prior items since 2026-04-23" and a draft rendered
    // it as "Nine CFTC items since 2026-04-23" — a 100-day claim on one day of
    // watching. Nothing fabricated; every date is a parsed field. The sentence
    // is still false, because it narrates the publisher's retention window as
    // our observation of a market.
    const events = ["2026-04-23", "2026-05-01", "2026-05-06", "2026-05-28", "2026-06-01",
                    "2026-06-03", "2026-06-18", "2026-06-29", "2026-07-07", "2026-07-31"];
    const ingest = "2026-08-01T17:18:42.000Z";
    let last = 0;
    for (const [i, d] of events.entries()) last = await seed("press_cftc_enforcement", `c${i}`, `${d}T12:00:00.000Z`, ingest);

    const ctx = await lakeContext(
      env.DB,
      { id: last, source: "press_cftc_enforcement", archetype: "REGULATORY_NEWS" } as never,
      { authority: "CFTC" } as never,
      NOW,
    );
    expect(countLine(ctx.lines), `lines were: ${JSON.stringify(ctx.lines)}`).toBeUndefined();
  });

  it("cites the count once coverage is long enough AND predates the window", async () => {
    // Same nine priors, but we have been watching since well before the
    // earliest event — which is the only case where "N since D" is true of the
    // world rather than of our backfill.
    const coverage = "2026-03-01T00:00:00.000Z";
    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = await seed("press_cftc_enforcement", `d${i}`, `2026-0${4 + (i % 4)}-1${i % 9}T12:00:00.000Z`, coverage);
    }
    const ctx = await lakeContext(
      env.DB,
      { id: last, source: "press_cftc_enforcement", archetype: "REGULATORY_NEWS" } as never,
      { authority: "CFTC" } as never,
      NOW,
    );
    expect(countLine(ctx.lines)).toBeDefined();
  });

  it("omits rather than shrinking: coverage 29 days is not rescued by a 29-day window", async () => {
    // The tempting fix is to quote the count over whatever window coverage
    // does support. A shorter window is a smaller TRUE statement that reads to
    // a human as a stronger one ("nine items in nine days"), so it is refused.
    const coverage = new Date(NOW.getTime() - 29 * 86_400_000).toISOString();
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = await seed("press_rbi", `e${i}`, new Date(NOW.getTime() - (28 - i) * 86_400_000).toISOString(), coverage);
    }
    const ctx = await lakeContext(
      env.DB,
      { id: last, source: "press_rbi", archetype: "REGULATORY_NEWS" } as never,
      { authority: "RBI" } as never,
      NOW,
    );
    expect(countLine(ctx.lines)).toBeUndefined();
    expect(MIN_COVERAGE_DAYS).toBe(30);
  });

  it("refuses when coverage is long but STARTS AFTER the window it would quote", async () => {
    // Backfill arriving late: we have watched 60 days, but this feed served us
    // items dated a year earlier on our first poll. The count would span a
    // period we were not watching.
    const coverage = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
    let last = 0;
    for (let i = 0; i < 9; i++) last = await seed("press_gao", `f${i}`, `2025-0${1 + i}-01T12:00:00.000Z`, coverage);
    const ctx = await lakeContext(
      env.DB,
      { id: last, source: "press_gao", archetype: "REGULATORY_NEWS" } as never,
      { authority: "GAO" } as never,
      NOW,
    );
    expect(countLine(ctx.lines)).toBeUndefined();
  });
});
