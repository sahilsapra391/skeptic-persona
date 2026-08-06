import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  salienceFor,
  parseCategoryCaps,
  CEILING_EXEMPT,
  DEFAULT_SALIENCE_FLOOR,
  DEFAULT_CAP_BYPASS_SCORE,
  DEFAULT_CATEGORY_CAPS,
  DEFAULT_CATEGORY_CAP,
  REGULATORY_NEWS_TIER,
} from "../src/salience";
import { PRESS_SOURCES } from "../src/ingesters/regulatoryPress";
import { etDay, etDayStartUtc, holdForDigest, promoteHeldItem, pushDigests, pushedTodayByCategory } from "../src/digest";
import { insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates";
import type { ArchetypeId, Payload } from "../src/templates/types";
import { enqueueForApproval, resetEnqueueLocks } from "../src/pipeline/enqueue";
import { paceChat, resetChatPacing, MAX_PACE_WAIT_MS } from "../src/lib/telegram";

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

  it("...and the DAILY CAP does not re-suppress what the floor deliberately let through", () => {
    // The round-one HIGH fixed one suppression mechanism and left its sibling.
    // The floor carve-out's own reasoning — "reachable only in a 21:00 ET
    // roll-up, up to 12.5h after an 08:30 ET print, while the committed TTLs
    // give MACRO_PRINT 12h precisely because it is time-critical" — applies
    // word for word to the cap, which held the third print of a heavy morning
    // to an evening roll-up arriving after its own TTL expired.
    //
    // None of the four can reach DEFAULT_CAP_BYPASS_SCORE, so the cap is the
    // only thing standing between them and the digest.
    for (const id of ["MACRO_PRINT", "FED_PRESS", "TREASURY_AUCTION", "RATE_DECISION"] as const) {
      expect(salienceFor(id, {}).score).toBeLessThan(DEFAULT_CAP_BYPASS_SCORE);
      const { caps } = parseCategoryCaps(undefined);
      expect(caps[id] ?? DEFAULT_CATEGORY_CAP).toBeGreaterThan(DEFAULT_CATEGORY_CAP);
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
    // THIS TEST USED TO PROVE NOTHING. It built a circular payload so
    // JSON.stringify would throw inside the gate, then asserted res.held was
    // undefined. But {items:[{code:'4.02'}], self:<circular>} scores 95, so
    // salienceHold took the `score >= bypass` branch and returned null BEFORE
    // parseCategoryCaps, pushedTodayByCategory, holdForDigest or any log call
    // that touches the payload. Nothing in the try block could throw, the
    // catch was never entered, and the identical assertion passed for a plain
    // non-circular payload. Third vacuous test found in this repo tonight.
    //
    // The gate can only fail where it touches D1, so break D1 — that is also
    // the failure the fail-open rule exists for.
    const id = await seed("GATE-6");
    // Break ONLY the gate's own query. Poisoning the whole DB proves nothing
    // useful: the gate would fail open correctly and then the render and the
    // insert would throw anyway, so the assertion could not tell "the gate let
    // it through" from "everything downstream also died".
    const realPrepare = env.DB.prepare.bind(env.DB);
    const brokenDb = {
      prepare(sql: string) {
        if (sql.includes("COUNT(*) AS n FROM queue")) throw new Error("D1_ERROR: gate query failed");
        return realPrepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    };
    // A score UNDER the bypass, so the gate must actually reach its D1 work
    // rather than short-circuiting the way the old payload did.
    const lowScore = { symbol: "AAPL", reasonCode: "T1", name: "Apple", reasonText: "News Pending", haltTimeEtShort: "09:30" };
    expect(salienceFor("HALT", lowScore).score).toBeLessThan(DEFAULT_CAP_BYPASS_SCORE);

    const res = await enqueueForApproval(
      { ...CURATED, DB: brokenDb } as never,
      id,
      "HALT",
      lowScore,
      "https://www.nasdaqtrader.com/x",
      NOW,
    );
    // Not held: a gate that cannot read D1 must let the item through.
    expect(res.held).toBeUndefined();
  });
});

describe("concurrency must not breach the ceilings this stack exists to enforce (p4-12)", () => {
  it("the daily category cap holds when several jobs enqueue the same archetype at once", async () => {
    // CHECK-THEN-ACT. pushedTodayByCategory reads, then ~4 awaits later
    // createQueueEntry writes. Serial execution made that safe; concurrency
    // does not. Several job families emit ONE archetype from MANY job rows —
    // halts_nasdaq + halts_nyse both push HALT, the ten rate_* jobs all push
    // RATE_DECISION, every FDA source pushes PRODUCT_RECALL — so two readers
    // land inside the same window and both see pushed < cap.
    resetEnqueueLocks();
    const capped = { ...env, CATEGORY_DAILY_CAPS: "HALT:1", CAP_BYPASS_SCORE: "101", SALIENCE_FLOOR: "0" } as never;

    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await insertItem(env.DB, {
        source: "halts_nasdaq", externalId: `CAPRACE-${i}`, category: "halt",
        eventAt: NOW.toISOString(), sourceUrl: `https://www.nasdaqtrader.com/x${i}`,
        payload: { symbol: `AA${i}`, reasonCode: "T1" }, score: SCORE_POSTABLE,
      });
      ids.push(res.id ?? 0);
    }

    // Fired together, exactly as three due HALT-pushing jobs would be.
    const results = await Promise.all(
      ids.map((id, i) =>
        enqueueForApproval(
          capped, id, "HALT",
          { symbol: `AA${i}`, reasonCode: "T1", name: `Test ${i}`, reasonText: "News Pending", haltTimeEtShort: "09:30" },
          `https://www.nasdaqtrader.com/x${i}`, NOW,
        ),
      ),
    );

    expect(results.filter((r) => r.queueId > 0).length).toBe(1); // was 3 before the lock
    expect(results.filter((r) => r.held === "category_cap").length).toBe(2); // losers held, not dropped
  });
});

describe("Telegram per-chat pacing survives concurrent jobs (p4-12)", () => {
  it("paces the CHAT, not each caller against itself", async () => {
    // The sleep used to live in each drain loop, pacing a job against its own
    // iterations. Concurrent jobs turned AAABBBCCC into ABCABCABC — three
    // messages inside one window, 3x Telegram's documented ~1 msg/s per chat.
    resetChatPacing();
    const SPACING = 40;
    const at: number[] = [];
    const started = performance.now();
    await Promise.all(
      [0, 1, 2].map(async () => {
        await paceChat("424242", SPACING);
        at.push(performance.now() - started);
      }),
    );
    at.sort((a, b) => a - b);
    expect(at[0]).toBeLessThan(SPACING); // the first send is not delayed
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(SPACING * 0.8);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(SPACING * 0.8);
  });

  it("a different chat is never delayed by another chat's queue", async () => {
    resetChatPacing();
    await paceChat("chat-a", 200);
    const started = performance.now();
    await paceChat("chat-b", 200);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("p5-03: the REGULATORY_NEWS tier", () => {
  const MACRO_TIER = salienceFor("MACRO_PRINT", {}).score;

  it("PARITY: every tier key is a real press authority, so a typo cannot silently do nothing", () => {
    // The failure this exists to catch: `REGULATORY_NEWS_TIER` is keyed on a
    // string, an absent key is a deliberate no-op, and so a misspelled key is
    // INDISTINGUISHABLE from a source we chose not to tier. The map would look
    // correct in review and change nothing in production.
    const authorities = new Set(PRESS_SOURCES.map((s) => s.authority));
    for (const key of Object.keys(REGULATORY_NEWS_TIER)) {
      expect(authorities.has(key), `${key} is not any press source's authority`).toBe(true);
    }
  });

  it("a BEA data print cards at the MACRO tier, exactly", () => {
    const bea = salienceFor("REGULATORY_NEWS", {
      authority: "Bureau of Economic Analysis",
      title: "U.S. International Trade in Goods and Services, June 2026",
    });
    expect(bea.score).toBe(MACRO_TIER);
    expect(bea.score).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR); // it still cards
    expect(bea.reasons.join(",")).toContain("DATA_PRINT");
  });

  it("an ONS release-calendar entry is digest-only and can never reach a card", () => {
    const ons = salienceFor("REGULATORY_NEWS", {
      authority: "UK ONS",
      title: "Consumer price inflation, UK: July 2026",
    });
    expect(ons.score).toBe(0);
    expect(ons.score).toBeLessThan(DEFAULT_SALIENCE_FLOOR);
    expect(ons.reasons.join(",")).toContain("RELEASE_CALENDAR");
  });

  it("a tiered source LOSES the ceiling exemption; an untiered one keeps it", () => {
    // The exemption was written for "enforcement actions". Establishing that a
    // source is a statistics feed is establishing it is not one of those, so
    // it cannot keep riding the exemption its archetype grants by proxy.
    expect(CEILING_EXEMPT.has("REGULATORY_NEWS")).toBe(true);
    expect(salienceFor("REGULATORY_NEWS", { authority: "Bureau of Economic Analysis" }).exempt).toBe(false);
    expect(salienceFor("REGULATORY_NEWS", { authority: "UK ONS" }).exempt).toBe(false);
    // ENFORCEMENT is the one tier that KEEPS it, because the owner's amendment
    // was written for enforcement actions in the first place.
    expect(salienceFor("REGULATORY_NEWS", { authority: "DOJ", title: "Two Charged in Securities Fraud Scheme" }).exempt).toBe(true);
    // Non-market DOJ press does not.
    expect(salienceFor("REGULATORY_NEWS", { authority: "DOJ", title: "Man Sentenced for Child Pornography" }).exempt).toBe(false);
    // An unruled source is untouched.
    expect(salienceFor("REGULATORY_NEWS", { authority: "UK FCA" }).exempt).toBe(true);
  });

  it("sources the owner has NOT ruled on are byte-identical: base 70, exempt, above the floor", () => {
    // The guard on scope creep, narrowed as the owner rules. It covered 24
    // sources under the BEA/ONS ruling; the 2026-08-06 content-tier ruling
    // names four more (DOJ, Bank of Japan, RBI, SEBI), so the guard now covers
    // the remaining twenty. If a later edit tiers a source he has not ruled
    // on, this still fails and names it.
    const RULED = ["DOJ", "Bank of Japan", "Reserve Bank of India", "SEBI"];
    const tiered = new Set([...Object.keys(REGULATORY_NEWS_TIER), ...RULED]);
    const untiered = PRESS_SOURCES.filter((s) => !tiered.has(s.authority));
    expect(untiered.length).toBe(PRESS_SOURCES.length - tiered.size);
    for (const s of untiered) {
      const got = salienceFor("REGULATORY_NEWS", { authority: s.authority, title: "x" });
      expect(got.score, `${s.id} changed score`).toBe(70);
      expect(got.exempt, `${s.id} changed exemption`).toBe(true);
      expect(got.score, `${s.id} fell below the floor`).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
    }
  });

  it("an unknown or missing authority is untouched, never accidentally demoted", () => {
    expect(salienceFor("REGULATORY_NEWS", {}).score).toBe(70);
    expect(salienceFor("REGULATORY_NEWS", { authority: "Some Future Regulator" }).score).toBe(70);
    expect(salienceFor("REGULATORY_NEWS", { authority: 42 as unknown as string }).score).toBe(70);
  });
});

describe("the pacing gate cannot outlive its invocation (2026-08-05 outage)", () => {
  it("REGRESSION: a discarded timer from a previous invocation must not hang the next send", async () => {
    // THE OUTAGE, reproduced. The old gate stored a PROMISE that resolved via
    // setTimeout, and returned the PREVIOUS one to the next caller:
    //
    //   const hold = wait.then(() => new Promise((r) => setTimeout(r, spacingMs)));
    //   chatGates.set(chatId, hold.catch(() => {}));
    //   return wait;
    //
    // A Workers invocation does not run pending timers once it ends. When a
    // tick's last act was a send, that timer never fired, the stored promise
    // never resolved, and EVERY later send in the isolate awaited it forever:
    // no message, no rejection, no log. The 1-minute cron kept the isolate
    // warm so nothing evicted it, and only a deploy cleared it. Ten hours of
    // approval cards were lost on 2026-08-05.
    //
    // vi.clearAllTimers() is exactly that event: timers scheduled by the
    // previous invocation are discarded without firing.
    resetChatPacing();
    vi.useFakeTimers();
    try {
      await paceChat("outage-chat", 1100); // first send: immediate, installs a slot

      vi.clearAllTimers(); // the invocation ends; its pending timer never runs

      // The next invocation must still be able to send. Under the OLD
      // implementation this was the discarded timer's promise, so advancing
      // the clock resolved nothing and this test would time out rather than
      // fail — which is precisely how the outage behaved in production.
      const p = paceChat("outage-chat", 1100);
      await vi.advanceTimersByTimeAsync(1100);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the cross-invocation state is a NUMBER, so a stale slot can only shorten a wait", async () => {
    // The structural property that makes the above impossible to reintroduce:
    // nothing awaited by one invocation is ever handed to another. A stale
    // timestamp is either in the past (no wait at all) or bounded by the cap.
    resetChatPacing();
    await paceChat("cap-chat", 10_000_000); // absurd spacing reserves a far-future slot
    const started = performance.now();
    await paceChat("cap-chat", 10_000_000);
    expect(performance.now() - started).toBeLessThanOrEqual(MAX_PACE_WAIT_MS + 250);
  });

  it("still serialises in ARRIVAL ORDER, which is why the chain existed", async () => {
    // The reservation is synchronous, so concurrent callers take strictly
    // successive slots exactly as the promise chain made them.
    resetChatPacing();
    const SPACING = 40;
    const order: number[] = [];
    await Promise.all([0, 1, 2].map(async (i) => { await paceChat("order-chat", SPACING); order.push(i); }));
    expect(order).toEqual([0, 1, 2]);
  });
});

describe("p5-03b: content tiers, written against REAL pending titles", () => {
  const t = (authority: string, title: string) => salienceFor("REGULATORY_NEWS", { authority, title });

  it("DOJ is positive-match only, so non-market press is LEDGER, never digest", () => {
    // Every one of these is a real pending title read from production on
    // 2026-08-06. Five of five DOJ items sampled had no market subject, which
    // is why the default excludes rather than includes.
    for (const title of [
      "Two Men Indicted for Laser Strikes on Police Helicopters",
      "Justice Department Sues Montgomery County, MD for Violating Supreme Court",
      "Justice Department Files Record 25 Denaturalization Cases Against Naturalized",
      "Illegal alien from Guatemala who caused head-on collision pleads guilty",
      "Portage County Man Sentenced to 20 Years in Prison For Child Pornography",
    ]) {
      const s = t("DOJ", title);
      expect(s.ledgerOnly, title).toBe(true);
      expect(s.exempt, title).toBe(false);
      expect(s.reasons.join(","), title).toContain("NON_MARKET");
    }
  });

  it("...and the DOJ cases the owner named DO card, at ENFORCEMENT", () => {
    for (const title of [
      "Hedge Fund Manager Charged in Securities Fraud Scheme",
      "Three Charged in Commodities Fraud and Market Manipulation",
      "Company Resolves Foreign Corrupt Practices Act Investigation",
      "Two Sentenced for Sanctions Evasion and Money Laundering",
      "Justice Department Sues to Block Merger on Antitrust Grounds",
      "Bank Executive Convicted of Bank Fraud",
    ]) {
      const s = t("DOJ", title);
      expect(s.ledgerOnly, title).toBe(false);
      expect(s.score, title).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
      // ENFORCEMENT is the tier the ceiling exemption was written for.
      expect(s.exempt, title).toBe(true);
    }
  });

  it("Bank of Japan: data prints card at MACRO, minutes and research are ledger", () => {
    const macro = salienceFor("MACRO_PRINT", {}).score;
    for (const title of [
      "Bank of Japan Accounts (July 31)",
      "Collateral Accepted by the Bank of Japan (End of July)",
      "Japanese Government Bonds Held by the Bank of Japan",
      "Sources of Changes in Current Account Balances (Projections for Aug.)",
    ]) {
      expect(t("Bank of Japan", title).score, title).toBe(macro);
    }
    for (const title of [
      "Minutes of the Monetary Policy Meeting on June 15 and 16, 2026",
      "(Research Paper) IMES DPS: Distance and Loan Pricing Revisited",
      "(BOJ Review) Impact of the Bank of Japan's Reductions in JGB Purchases",
    ]) {
      expect(t("Bank of Japan", title).ledgerOnly, title).toBe(true);
    }
  });

  it("a policy decision digests by default and cards only on a change", () => {
    const routine = t("Reserve Bank of India", "Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee");
    expect(routine.score).toBeLessThan(DEFAULT_SALIENCE_FLOOR);
    expect(routine.ledgerOnly).toBe(false); // digest, not ledger
    // A change, a surprise, or an unscheduled action lifts it.
    for (const title of [
      "Unscheduled Monetary Policy Meeting Announced",
      "Monetary Policy Statement: Committee cuts the policy rate",
      "Bank of Japan announces intervention in the foreign exchange market",
    ]) {
      const s = t(title.includes("Japan") ? "Bank of Japan" : "Reserve Bank of India", title);
      expect(s.score, title).toBeGreaterThanOrEqual(DEFAULT_SALIENCE_FLOOR);
    }
  });

  it("RBI: auction results and data releases card at MACRO; consultations are ledger", () => {
    const macro = salienceFor("MACRO_PRINT", {}).score;
    for (const title of [
      "Result of Yield/Price Based Auction of State Government Securities",
      "State Government Securities - Full Auction Result",
      "Money Market Operations as on August 4, 2026",
      "RBI releases data on ECB / FCCB / RDB for June 2026",
    ]) {
      expect(t("Reserve Bank of India", title).score, title).toBe(macro);
    }
    expect(t("Reserve Bank of India", "RBI invites public comments on Draft Guidelines for 'on tap' Licensing").ledgerOnly).toBe(true);
    // An action against a bank is a financial-institution case.
    expect(t("Reserve Bank of India", "Directions under Section 35A read with Section 56 of the Banking Regulation Act").exempt).toBe(true);
  });

  it("SEBI: appeal dockets and individuals are ledger; orders card", () => {
    // Seven of the eleven pending SEBI items were appeal dockets.
    for (const title of [
      "Appeal No. 6970 of 2026 filed by Parthasarathi",
      "Appeal No. 6964 of 2026 filed by Ravi Prakashkumar Shah",
      "Remittance Order dated 04.08.2026 issued against Vinet Rajkumar Chopda HUF",
      "Settlement Order in respect of Mr. Raghav Raj Kanoria in the matter of India P",
    ]) {
      expect(t("SEBI", title).ledgerOnly, title).toBe(true);
    }
    expect(t("SEBI", "Order in the matter of certain Research Analysts").ledgerOnly).toBe(false);
  });

  it("an unruled authority is completely untouched", () => {
    const s = t("UK FCA", "FCA fines a firm for market abuse");
    expect(s.score).toBe(70);
    expect(s.exempt).toBe(true);
    expect(s.ledgerOnly).toBe(false);
  });
});
