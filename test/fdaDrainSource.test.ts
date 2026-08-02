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
});
