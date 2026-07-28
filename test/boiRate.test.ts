import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import BOI from "./fixtures/boi-interest.json.fixture?raw";
import {
  changeFromCursor,
  detectChange,
  draftRate,
  latestEffective,
  makeRateHandler,
  RATE_SOURCES,
  type RateObservation,
} from "../src/ingesters/rates";
import { getSourceState } from "../src/lib/db";
import { newTickBudget } from "../src/lib/budget";

// Live-verified 2026-07-28T06:05Z: {"currentInterest":3.5,
// "nextInterestDate":"2026-09-01T00:00:00Z",
// "lastPublishedDate":"2026-07-12T08:59:20.943Z"}

const src = RATE_SOURCES.find((s) => s.id === "rate_boi")!;
const NOW = new Date("2026-07-28T06:00:00Z");

describe("Bank of Israel rate", () => {
  it("declares itself a single-observation source", () => {
    expect(src.singleObservation).toBe(true);
    expect(src.attribution).toMatch(/^per /);
  });

  it("dates the observation by when the level was published", () => {
    const obs = src.parse(BOI);
    expect(obs).toEqual([{ date: "2026-07-12", value: 3.5 }]);
    expect(latestEffective(obs, NOW)).toEqual({ date: "2026-07-12", value: 3.5 });
  });

  it("ignores nextInterestDate, which is a meeting and not a rate", () => {
    expect(BOI).toContain("nextInterestDate");
    expect(src.parse(BOI).some((o) => o.date === "2026-09-01")).toBe(false);
  });

  it("cannot detect a change from the feed alone, which is the whole point", () => {
    // One observation means no prior. Without the cursor fallback this source
    // would log forever while looking perfectly healthy.
    expect(detectChange(src.parse(BOI), NOW)).toBeNull();
  });

  it("returns nothing rather than guessing on a malformed body", () => {
    expect(src.parse("{}")).toEqual([]);
    expect(src.parse('{"currentInterest":null,"lastPublishedDate":"2026-07-12T00:00:00Z"}')).toEqual([]);
    expect(src.parse('{"currentInterest":3.5,"lastPublishedDate":"not-a-date"}')).toEqual([]);
    expect(src.parse('{"currentInterest":3.5}')).toEqual([]);
  });
});

describe("changeFromCursor", () => {
  const current: RateObservation = { date: "2026-09-01", value: 3.75 };

  it("builds a change from the level we recorded ourselves", () => {
    const change = changeFromCursor("2026-07-12:3.5", current);
    expect(change).toBeTruthy();
    expect(change!.prior).toEqual({ date: "2026-07-12", value: 3.5 });
    expect(change!.direction).toBe("raised");
    expect(change!.bps).toBe(25);
    expect(draftRate(src, change!)).toBe(
      "Israel: Bank of Israel interest rate raised to 3.75% from 3.5%, effective 2026-09-01",
    );
  });

  it("reads a cut as a cut", () => {
    const change = changeFromCursor("2026-07-12:3.5", { date: "2026-09-01", value: 3.25 });
    expect(change!.direction).toBe("lowered");
    expect(change!.bps).toBe(25);
  });

  it("calls a hold no change", () => {
    // The bank meets, publishes a new lastPublishedDate, holds the rate.
    expect(changeFromCursor("2026-07-12:3.5", { date: "2026-09-01", value: 3.5 })).toBeNull();
  });

  it("refuses a prior that does not precede the current observation", () => {
    // Same print re-read, or clock skew. Neither is a change.
    expect(changeFromCursor("2026-09-01:3.5", current)).toBeNull();
    expect(changeFromCursor("2026-09-02:3.5", current)).toBeNull();
  });

  it("refuses an absent or unparseable cursor instead of inventing a prior", () => {
    // The baseline poll: nothing recorded yet, so nothing can be claimed.
    expect(changeFromCursor(null, current)).toBeNull();
    expect(changeFromCursor("", current)).toBeNull();
    expect(changeFromCursor("2026-07-12", current)).toBeNull();
    expect(changeFromCursor("2026-07-12:", current)).toBeNull();
    expect(changeFromCursor("2026-07-12:abc", current)).toBeNull();
    expect(changeFromCursor(":3.5", current)).toBeNull();
  });

  it("is not applied to history-bearing sources", () => {
    // THE REASON THIS IS OPT-IN. If a rate moved while we were down and has
    // been flat since, detectChange correctly calls it old news. A blanket
    // cursor fallback would still hold the pre-move level and would present a
    // days-old move as today's.
    for (const s of RATE_SOURCES) {
      if (s.id === "rate_boi") continue;
      expect(s.singleObservation, s.id).toBeUndefined();
    }
  });
});

describe("single-observation source, end to end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  function serve(body: string) {
    const u = new URL(src.url!);
    fetchMock.get(u.origin).intercept({ path: u.pathname + u.search }).reply(200, body);
  }

  it("baselines on first sighting, then posts the next move as news", async () => {
    // Poll 1: nothing recorded yet, so nothing can be claimed.
    serve(BOI);
    await makeRateHandler(src)(env, NOW, newTickBudget(20));

    let rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1 ORDER BY id")
      .bind(src.id)
      .all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]?.status).toBe("logged");
    expect((await getSourceState(env.DB, src.id)).cursor).toBe("2026-07-12:3.5");

    // Poll 2: the bank moves. The prior is the level WE recorded, which is
    // the only reason this source can ever say anything.
    serve('{"currentInterest":3.75,"nextInterestDate":"2026-10-15T00:00:00Z","lastPublishedDate":"2026-09-01T09:00:00.000Z"}');
    await makeRateHandler(src)(env, new Date("2026-09-01T10:00:00Z"), newTickBudget(20));

    rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1 ORDER BY id")
      .bind(src.id)
      .all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(2);
    // The handler enqueues in the same pass, so a real move lands in the
    // approval queue rather than waiting at 'new' for a later tick.
    expect(rows.results[1]?.status).toBe("queued");

    const p = await env.DB.prepare(
      "SELECT json_extract(payload,'$.factLine') AS f, json_extract(payload,'$.priorValue') AS pv, json_extract(payload,'$.changeBps') AS bps FROM items WHERE source = ?1 ORDER BY id DESC LIMIT 1",
    )
      .bind(src.id)
      .first<{ f: string; pv: number; bps: number }>();
    expect(p?.pv).toBe(3.5);
    expect(p?.bps).toBe(25);
    expect(p?.f).toBe("Israel: Bank of Israel interest rate raised to 3.75% from 3.5%, effective 2026-09-01");

    const card = await env.DB.prepare(
      "SELECT archetype, draft_text FROM queue ORDER BY id DESC LIMIT 1",
    ).first<{ archetype: string; draft_text: string }>();
    expect(card?.archetype).toBe("RATE_DECISION");
    // RATE_DECISION carries the generic issuer attribution; the fact line
    // names the country and the source link is boi.org.il. Naming each bank
    // individually is a follow-up (see the closed attribution map added for
    // CONGRESS_PTR), not a correctness gap.
    expect(card?.draft_text).toContain("per the central bank");
    expect(card?.draft_text).toContain("Israel");
    // Every number in the card came from a parsed field or from a level we
    // recorded ourselves. Nothing here is inferred.
    expect(card?.draft_text).toContain("3.75%");
    expect(card?.draft_text).toContain("3.5%");
  });

  it("a hold republished with a new date is not news", async () => {
    serve(BOI);
    await makeRateHandler(src)(env, NOW, newTickBudget(20));
    // Same rate, new publication date: the bank met and held.
    serve('{"currentInterest":3.5,"nextInterestDate":"2026-11-01T00:00:00Z","lastPublishedDate":"2026-09-01T09:00:00.000Z"}');
    await makeRateHandler(src)(env, new Date("2026-09-01T10:00:00Z"), newTickBudget(20));

    const rows = await env.DB.prepare("SELECT status FROM items WHERE source = ?1 ORDER BY id")
      .bind(src.id)
      .all<{ status: string }>();
    expect(rows.results.every((r) => r.status === "logged")).toBe(true);
    const cards = await env.DB.prepare("SELECT COUNT(*) AS n FROM queue").first<{ n: number }>();
    expect(cards?.n).toBe(0);
  });
});
