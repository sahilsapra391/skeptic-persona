import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  salienceFor,
  parseCategoryCaps,
  CEILING_EXEMPT,
  DEFAULT_SALIENCE_FLOOR,
  DEFAULT_CAP_BYPASS_SCORE,
  DEFAULT_CATEGORY_CAPS,
} from "../src/salience";
import { etDay, etDayStartUtc, holdForDigest, promoteHeldItem, pushDigests, pushedTodayByCategory } from "../src/digest";
import { insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates";
import type { ArchetypeId, Payload } from "../src/templates/types";
import { enqueueForApproval } from "../src/pipeline/enqueue";

const NOW = new Date("2026-08-03T18:00:00.000Z"); // Monday, 14:00 ET

/** Curation is disabled in the shared test env (see vitest.config.ts); these
 *  tests are the ones that must exercise it, so they opt back in. */
const CURATED = { ...env, SALIENCE_FLOOR: "45", CAP_BYPASS_SCORE: "80" };

describe("salience scoring", () => {
  it("demotes the four measured flood classes below the floor", () => {
    // Each of these was measured on 2026-08-01 as a dominant, never-approved
    // sub-class inside an otherwise good source.
    const eightK502 = salienceFor("FILING_8K", { items: [{ code: "5.02", title: "Departure of Directors" }] });
    const haltVol = salienceFor("HALT", { reasonCode: "LUDP" });
    const stakeAmend = salienceFor("OWNERSHIP_STAKE", { topPercent: 6.2, isAmendment: true });
    const smallNotice = salienceFor("INSIDER_NOTICE", { aggregateMarketValue: 1_200_000 });
    for (const s of [eightK502, haltVol, stakeAmend, smallNotice]) {
      expect(s.score).toBeLessThan(DEFAULT_SALIENCE_FLOOR);
    }
  });

  it("keeps the signal inside those same sources above the floor", () => {
    expect(salienceFor("FILING_8K", { items: [{ code: "4.02" }] }).score).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
    expect(salienceFor("HALT", { reasonCode: "T1" }).score).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
    expect(salienceFor("OWNERSHIP_STAKE", { topPercent: 12.5 }).score).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
    expect(salienceFor("INSIDER_NOTICE", { aggregateMarketValue: 40_000_000 }).score).toBeGreaterThanOrEqual(
      DEFAULT_SALIENCE_FLOOR,
    );
  });

  it("reads the VERIFIED payload shapes, not plausible-looking ones", () => {
    // Regression pins for three field names that were wrong in the first
    // draft and would have silently scored every item at its bare base:
    // items[] holds objects not strings; Form 4 has totals.buyValue (no
    // totals.value); Schedule 13 has topPercent (no percentOfClass).
    const objForm = salienceFor("FILING_8K", { items: [{ code: "4.02", title: "t" }] }).score;
    const strForm = salienceFor("FILING_8K", { items: ["4.02"] }).score;
    expect(objForm).toBe(strForm);
    expect(objForm).toBeGreaterThan(salienceFor("FILING_8K", {}).score);

    expect(salienceFor("FILING_FORM4", { totals: { buyValue: 12_000_000 } }).score).toBeGreaterThan(
      salienceFor("FILING_FORM4", { totals: { value: 12_000_000 } }).score,
    );
    expect(salienceFor("OWNERSHIP_STAKE", { topPercent: 18 }).score).toBeGreaterThan(
      salienceFor("OWNERSHIP_STAKE", { percentOfClass: 18 }).score,
    );
  });

  it("the owner's exempt categories are exempt and score high", () => {
    expect([...CEILING_EXEMPT].sort()).toEqual(["CONGRESS_PTR", "POLICY_ACTION", "REGULATORY_NEWS"]);
    const ptr = salienceFor("CONGRESS_PTR", { member: "Hon. Example" });
    expect(ptr.exempt).toBe(true);
    expect(ptr.score).toBeGreaterThanOrEqual(DEFAULT_CAP_BYPASS_SCORE);
  });

  it("never returns a score outside 0-100, whatever the payload", () => {
    for (const p of [{}, { items: [] }, { reasonCode: "???" }, { aggregateMarketValue: -5 }, { topPercent: 1e9 }]) {
      for (const a of ["FILING_8K", "HALT", "INSIDER_NOTICE", "OWNERSHIP_STAKE", "NOT_AN_ARCHETYPE"]) {
        const s = salienceFor(a, p);
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it("cap overrides merge over defaults and skip garbage rather than zeroing", () => {
    const { caps, skipped } = parseCategoryCaps("HALT:9,bogus,halt:3,HALT:x,FILING_8K:0");
    expect(caps["HALT"]).toBe(9);
    expect(caps["FILING_8K"]).toBe(0); // an explicit 0 is a real choice
    expect(caps["INSIDER_NOTICE"]).toBe(DEFAULT_CATEGORY_CAPS["INSIDER_NOTICE"]);
    // Only genuinely malformed entries are skipped; "LOWER:2" is a valid
    // (if unused) archetype key and is accepted as written.
    expect(skipped).toEqual(["bogus", "halt:3", "HALT:x"]);
  });
});

describe("no category can be unreachable (review HIGH)", () => {
  it("every archetype can clear the floor with SOME payload", () => {
    // The defect this pins: a base below the floor with NO magnitude branch
    // means the category can never reach the queue for ANY payload. CPI, the
    // jobs report, Fed releases and sub-50bp rate decisions were all in that
    // state, reachable only in a 21:00 ET roll-up — while the committed TTLs
    // give MACRO_PRINT 12h precisely because it is time-critical.
    //
    // "Reachable" means a REAL payload can clear the floor, not that a bare
    // {} does. HALT sits at 40 deliberately: a halt whose reasonCode did not
    // parse should be held, because we cannot say why it halted — and every
    // real halt payload carries one (halts.ts). So each archetype gets its
    // best-case probe, and an archetype with no probe must clear on {}.
    const BEST_CASE: Partial<Record<ArchetypeId, Payload>> = {
      HALT: { reasonCode: "T1" },
      FILING_8K: { items: [{ code: "4.02" }] },
      INSIDER_NOTICE: { aggregateMarketValue: 40_000_000 },
      FILING_FORM4: { totals: { buyValue: 12_000_000 } },
      OWNERSHIP_STAKE: { topPercent: 18 },
      PRODUCT_RECALL: { classification: "Class I" },
      RATE_DECISION: { changeBps: 50 },
    };
    const unreachable: string[] = [];
    for (const id of Object.keys(ARCHETYPES) as ArchetypeId[]) {
      const s = salienceFor(id, BEST_CASE[id] ?? {});
      if (!s.exempt && s.score < DEFAULT_SALIENCE_FLOOR) unreachable.push(`${id}=${s.score}`);
    }
    expect(unreachable).toEqual([]);
  });

  it("a halt whose reason did not parse is held, and that is deliberate", () => {
    // The one category intentionally below the floor on a bare payload.
    expect(salienceFor("HALT", {}).score).toBeLessThan(DEFAULT_SALIENCE_FLOOR);
    expect(salienceFor("HALT", { reasonCode: "T1" }).score).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
  });

  it("the time-critical categories specifically reach the queue", () => {
    for (const id of ["MACRO_PRINT", "FED_PRESS", "TREASURY_AUCTION", "RATE_DECISION"] as const) {
      expect(salienceFor(id, {}).score).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
    }
  });

  it("an out-of-range SALIENCE_FLOOR falls back instead of holding everything", async () => {
    const id = await (async () => {
      const res = await insertItem(env.DB, {
        source: "bls", externalId: "FLOOR-1", category: "macro_print",
        eventAt: NOW.toISOString(), sourceUrl: "https://www.bls.gov/x",
        payload: { factLine: "BLS: CPI rose 0.3% in July" }, score: SCORE_POSTABLE,
      });
      return res.id ?? 0;
    })();
    // "450" is a plausible fat-finger of "45" and would hold every item.
    const res = await enqueueForApproval(
      { ...env, SALIENCE_FLOOR: "450" } as never,
      id, "MACRO_PRINT", { factLine: "BLS: CPI rose 0.3% in July" }, "https://www.bls.gov/x", NOW,
    );
    expect(res.held).toBeUndefined();
  });
});

describe("the digest accounts for every held row (review rounds 2-3)", () => {
  // ONE persisted interceptor, registered once — several persisted mocks on
  // the same path shadow each other and 404 the later calls.
  let sends = 0;
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ path: `/botTEST:TOKEN/sendMessage`, method: "POST" })
      .reply(200, () => {
        sends += 1;
        return JSON.stringify({ ok: true, result: { message_id: 900 + sends } });
      })
      .persist();
  });

  async function held(externalId: string, payload: Record<string, unknown>, score: number): Promise<number> {
    const res = await insertItem(env.DB, {
      source: "edgar_8k", externalId, category: "filing",
      eventAt: NOW.toISOString(), sourceUrl: "https://www.sec.gov/x",
      payload, score: SCORE_POSTABLE,
    });
    const id = res.id ?? 0;
    await holdForDigest(CURATED, id, "FILING_8K", score, "below_floor", NOW);
    return id;
  }

  it("a partially-renderable group leaves nothing unsent", async () => {
    // The TOP scorer is unrenderable: the exact shape that made round one
    // mark a row sent while showing it nowhere.
    await held("ACC-bad", {}, 99);
    for (let i = 0; i < 3; i++) await held(`ACC-ok-${i}`, { items: [{ code: "5.02", title: "Departure of Directors or Certain Officers" }], cik: "1", company: "A Co" }, 50 - i);
    const before = sends;

    await pushDigests(CURATED as never, NOW);

    expect(sends).toBeGreaterThan(before); // a card went out
    const unsent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM digest_items WHERE sent_at IS NULL`).first<{ n: number }>();
    expect(unsent?.n).toBe(0); // and nothing is left to retry forever
  });

  it("a group where NOTHING renders still sends the owner a message", async () => {
    for (let i = 0; i < 3; i++) await held(`ACC-none-${i}`, {}, 40 + i);
    const before = sends;

    await pushDigests(CURATED as never, NOW);

    // Round three: this path used to send ZERO messages and log only, so the
    // owner saw nothing and could conclude nothing had been held.
    expect(sends).toBeGreaterThan(before);
    const unsent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM digest_items WHERE sent_at IS NULL`).first<{ n: number }>();
    expect(unsent?.n).toBe(0);
  });

  it("a promotion that THROWS restores the item so the button still works", async () => {
    // The regression round three introduced: the claim flips 'digested' ->
    // 'new' first, and renderForQueue can throw, so an unguarded failure
    // stranded the item outside every drain with its digest row already sent.
    // A payload with no renderable skeleton is the reachable trigger.
    const id = await held("ACC-throws", { items: [{ code: "5.02" }] }, 40); // no title -> firstClause raises
    const out = await promoteHeldItem(CURATED as never, id, NOW);
    expect(out).toBeNull();
    const row = await env.DB.prepare(`SELECT status FROM items WHERE id = ?1`).bind(id).first<{ status: string }>();
    // Back to 'digested', not stranded in 'new' or parked as 'logged'.
    expect(row?.status).toBe("digested");
  });

  it("promotion is idempotent — a second tap never builds a second card", async () => {
    const id = await held("ACC-promote", { items: [{ code: "5.02", title: "Departure of Directors or Certain Officers" }], cik: "1", company: "A Co" }, 40);

    const first = await promoteHeldItem(CURATED as never, id, NOW);
    const second = await promoteHeldItem(CURATED as never, id, NOW);

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // status is no longer 'digested'
    const cards = await env.DB.prepare(`SELECT COUNT(*) AS n FROM queue WHERE item_id = ?1`).bind(id).first<{ n: number }>();
    expect(cards?.n).toBe(1);
  });
});

describe("digest day boundaries", () => {
  it("groups by ET calendar day, not UTC", () => {
    // 2026-08-04T02:00Z is 22:00 ET on 08-03: still the same trading day.
    expect(etDay(new Date("2026-08-04T02:00:00.000Z"))).toBe("2026-08-03");
    expect(etDay(new Date("2026-08-03T18:00:00.000Z"))).toBe("2026-08-03");
    const start = etDayStartUtc(new Date("2026-08-04T02:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-03T04:00:00.000Z"); // EDT = UTC-4
  });
});

describe("the enqueue gate", () => {
  async function seed(externalId: string): Promise<number> {
    const res = await insertItem(env.DB, {
      source: "edgar_8k",
      externalId,
      category: "filing",
      eventAt: NOW.toISOString(),
      sourceUrl: "https://www.sec.gov/x",
      payload: { items: [{ code: "5.02" }] },
      score: SCORE_POSTABLE,
    });
    return res.id ?? 0;
  }

  it("holds a below-floor item, marks it digested, and creates no card", async () => {
    const id = await seed("GATE-1");
    const res = await enqueueForApproval(
      CURATED,
      id,
      "FILING_8K",
      { items: [{ code: "5.02" }], cik: "1", ticker: "AAA", companyName: "A Co" },
      "https://www.sec.gov/x",
      NOW,
    );
    expect(res.held).toBe("below_floor");
    expect(res.queueId).toBe(0);

    const item = await env.DB.prepare(`SELECT status FROM items WHERE id = ?1`).bind(id).first<{ status: string }>();
    // 'digested' is distinct from 'logged': met the bar, lost the slot.
    expect(item?.status).toBe("digested");
    const held = await env.DB.prepare(`SELECT archetype, reason, day FROM digest_items WHERE item_id = ?1`)
      .bind(id)
      .first<{ archetype: string; reason: string; day: string }>();
    expect(held).toMatchObject({ archetype: "FILING_8K", reason: "below_floor", day: "2026-08-03" });
    const cards = await env.DB.prepare(`SELECT COUNT(*) AS n FROM queue WHERE item_id = ?1`).bind(id).first<{ n: number }>();
    expect(cards?.n).toBe(0);
  });

  it("holding is idempotent — a re-processed item never doubles a digest line", async () => {
    const id = await seed("GATE-2");
    await holdForDigest(CURATED, id, "FILING_8K", 35, "below_floor", NOW);
    await holdForDigest(CURATED, id, "FILING_8K", 35, "below_floor", NOW);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM digest_items WHERE item_id = ?1`)
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("a bypassSalience call (digest promotion) skips the gate entirely", async () => {
    const id = await seed("GATE-3");
    const res = await enqueueForApproval(
      CURATED,
      id,
      "FILING_8K",
      { items: [{ code: "5.02" }], cik: "1", ticker: "BBB", companyName: "B Co" },
      "https://www.sec.gov/x",
      NOW,
      undefined,
      { bypassSalience: true },
    );
    expect(res.held).toBeUndefined();
    // The item renders or parks, but it was never diverted to a digest.
    const held = await env.DB.prepare(`SELECT COUNT(*) AS n FROM digest_items WHERE item_id = ?1`)
      .bind(id)
      .first<{ n: number }>();
    expect(held?.n).toBe(0);
  });

  it("the daily cap counts only today's cards for that archetype", async () => {
    const before = await pushedTodayByCategory(env.DB, "MACRO_PRINT", NOW);
    expect(before).toBe(0);
    const id = await seed("GATE-4");
    await env.DB.prepare(
      `INSERT INTO queue (item_id, archetype, draft_text, state, created_at) VALUES (?1, 'MACRO_PRINT', 'd', 'pending', ?2)`,
    )
      .bind(id, NOW.toISOString())
      .run();
    expect(await pushedTodayByCategory(env.DB, "MACRO_PRINT", NOW)).toBe(1);
    // Yesterday's card must not count against today.
    const old = await seed("GATE-5");
    await env.DB.prepare(
      `INSERT INTO queue (item_id, archetype, draft_text, state, created_at) VALUES (?1, 'MACRO_PRINT', 'd', 'pending', ?2)`,
    )
      .bind(old, "2026-08-01T18:00:00.000Z")
      .run();
    expect(await pushedTodayByCategory(env.DB, "MACRO_PRINT", NOW)).toBe(1);
  });

  it("a gate failure pushes the item — curation may cost noise, never silence", async () => {
    const id = await seed("GATE-6");
    // A payload that throws on JSON round-trip inside the gate's logging path
    // must not swallow the item. Circular structure = JSON.stringify throws.
    const circular: Record<string, unknown> = { items: [{ code: "4.02" }] };
    circular["self"] = circular;
    const res = await enqueueForApproval(CURATED, id, "FILING_8K", circular, "https://www.sec.gov/x", NOW);
    // Either it rendered or it parked as unrenderable, but it was NOT held.
    expect(res.held).toBeUndefined();
  });
});
