import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FOOD from "./fixtures/fda-drug-enforcement.json.fixture?raw";
import { FDA_SOURCES, groupRecalls, parseRecalls, pollFdaEnforcement } from "../src/ingesters/fdaRecalls";
import { insertItem, SCORE_AUTO_ALERT } from "../src/lib/db";

const NOW = new Date("2026-08-01T12:00:00.000Z");

describe("each FDA lane drains its OWN items", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("does not leave a non-drug lane's postable items stranded at 'new'", async () => {
    // THE BUG: the pending-drain query bound the module constant SOURCE
    // ("fda_drug_recall") instead of src.id, so polling the food or device
    // lane enqueued DRUG rows and left its own permanently at status='new'.
    // fda_food_recall has been in that state since migration 0041.
    const food = FDA_SOURCES.find((s) => s.id === "fda_food_recall")!;
    const events = groupRecalls(parseRecalls(FOOD)).slice(0, 2);

    for (const [i, e] of events.entries()) {
      await insertItem(
        env.DB,
        {
          source: food.id,
          externalId: `seed-${i}`,
          category: "recall",
          eventAt: NOW.toISOString(),
          sourceUrl: food.pageUrl,
          payload: { firm: e.firm, classification: e.classification, reason: e.reason, product: e.product, kind: food.kind, factLine: `FDA ${e.classification} food recall: ${e.firm}` },
          score: SCORE_AUTO_ALERT,
          status: "new",
        },
        NOW,
      );
    }

    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items WHERE source = ?1 AND status = 'new'`,
    ).bind(food.id).first<{ n: number }>();
    expect(before!.n).toBe(2);

    // The fetch must SUCCEED: the drain sits after the try/catch and the
    // catch returns, so a failed poll skips it entirely.
    const api = "https://api.fda.gov";
    fetchMock.get(api).intercept({ path: food.url.replace(api, "") }).reply(200, FOOD);
    await pollFdaEnforcement(env as never, food, NOW);

    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items WHERE source = ?1 AND status = 'new'`,
    ).bind(food.id).first<{ n: number }>();

    // Bound to SOURCE this stayed at 2 forever. Bound to src.id the lane
    // picks up its own rows.
    expect(after!.n).toBeLessThan(before!.n);
  });

  it("drains a multi-day backlog in bounded batches and finishes", async () => {
    // WHY THIS EXISTS. The food lane has never successfully drained, so the
    // first poll after the fix meets the largest backlog it will ever meet.
    // A path that has never run goes wrong at volume rather than one row at
    // a time.
    //
    // What this pins, stated narrowly because a wider claim was not true when
    // I checked: draining is BOUNDED per poll and it COMPLETES. Raising the
    // SQL LIMIT alone does not fail this test, so it is not a test of the
    // literal 3 -- the drain has a second bound (the tick budget, and the
    // retryAfter break on queue pacing) and any of them satisfies it.
    const food = FDA_SOURCES.find((s) => s.id === "fda_food_recall")!;
    const events = groupRecalls(parseRecalls(FOOD));
    const BACKLOG = 8;

    for (let i = 0; i < BACKLOG; i++) {
      const e = events[i % events.length]!;
      await insertItem(
        env.DB,
        {
          source: food.id,
          externalId: `backlog-${i}`,
          category: "recall",
          // Four days stale, which is what four days of not draining looks
          // like. The freshness decision was made correctly AT INGEST and the
          // drain deliberately does not re-make it, so these still queue --
          // dated, because draftRecall prints the initiation date.
          eventAt: "2026-07-28T12:00:00.000Z",
          sourceUrl: food.pageUrl,
          payload: {
            firm: `${e.firm} ${i}`,
            classification: "Class I",
            reason: e.reason,
            product: e.product,
            kind: food.kind,
            factLine: `FDA Class I food recall: ${e.firm} ${i}`,
          },
          score: SCORE_AUTO_ALERT,
          status: "new",
        },
        NOW,
      );
    }

    const stranded = async () =>
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM items WHERE source = ?1 AND status = 'new' AND external_id LIKE 'backlog-%'`,
        )
          .bind(food.id)
          .first<{ n: number }>()
      )!.n;

    expect(await stranded()).toBe(BACKLOG);

    const api = "https://api.fda.gov";
    const path = food.url.replace(api, "");
    const seen: number[] = [];
    for (let poll = 0; poll < 6; poll++) {
      fetchMock.get(api).intercept({ path }).reply(200, FOOD);
      await pollFdaEnforcement(env as never, food, NOW);
      seen.push(await stranded());
    }

    // Monotonic: a poll never strands MORE than the one before it.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!, `poll ${i} went backwards`).toBeLessThanOrEqual(seen[i - 1]!);
    }
    // Progress on the first poll, so a stalled drain is caught.
    expect(seen[0]!).toBeLessThan(BACKLOG);
    // And it finishes rather than stalling partway, with the last two polls
    // proving the drain is a no-op once the backlog is gone.
    expect(seen[seen.length - 1]).toBe(0);
    expect(seen[seen.length - 2]).toBe(0);
  });
});
