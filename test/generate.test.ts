import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPrompt, eligibleBeats, runGeneration } from "../src/rag/generate";
import { parseVariants } from "../src/rag/openrouter";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { iso } from "../src/lib/time";
import type { ArchetypeId } from "../src/templates/types";

const NOW = new Date("2026-07-28T15:00:00Z");

// A PTR payload rich enough to render and to validate against.
const PTR_PAYLOAD = {
  member: "Jane Roe",
  chamber: "Senate",
  ticker: "LMT",
  company: "Lockheed Martin",
  band: "$1,000,001 - $5,000,000",
  amountMin: 1000001,
  amountMax: 5000000,
  txType: "purchase",
  tradeDate: "2026-06-03",
  disclosedDate: "2026-07-18",
  lagDays: 45,
  factLine: "Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase of $LMT, trade date 2026-06-03",
  trades: [{ ticker: "LMT", band: "$1,000,001 - $5,000,000" }],
};

const EXEMPLAR = {
  archetype: "CONGRESS_PTR" as ArchetypeId,
  text: "Senate PTR: $500,001 - $1,000,000 sale, trade date May 2, per Senate eFD.\n\nDisclosed 41 days later.",
};

const genEnv = () =>
  Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
    OPENROUTER_API_KEY: "TESTKEY",
    OPENROUTER_MODEL: "test/model",
  });

const OR = "https://openrouter.ai";
let nextReply: () => unknown = () => ({});
let nextStatus = 200; // mutable: persisted interceptors shadow later ones, so ONE interceptor serves all cases
let orCalls = 0;

const TGRAM = { calls: [] as string[] };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get(OR)
    .intercept({ path: "/api/v1/chat/completions", method: "POST" })
    .reply(() => {
      orCalls += 1;
      const data =
        nextStatus === 200
          ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(nextReply()) } }] })
          : JSON.stringify({ error: { message: "Invalid key", code: nextStatus } });
      return { statusCode: nextStatus, data };
    })
    .persist();
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ path: /\/botTEST:TOKEN\/sendMessage/, method: "POST" })
    .reply(200, (opts) => {
      TGRAM.calls.push(String(opts.body));
      return JSON.stringify({ ok: true, result: { message_id: 1 } });
    })
    .persist();
});

async function seedApproved(externalId: string, payload: object = PTR_PAYLOAD, archetype = "CONGRESS_PTR", draft?: string): Promise<number> {
  const item = await insertItem(env.DB, {
    source: "senate_ptr",
    externalId,
    category: "congress",
    eventAt: iso(NOW),
    sourceUrl: `https://efdsearch.senate.gov/${externalId}`,
    payload: payload as Record<string, unknown>,
    score: SCORE_POSTABLE,
  });
  const queueId = await createQueueEntry(
    env.DB,
    item.id ?? 0,
    archetype,
    draft ?? "Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase, trade date 2026-06-03, per Senate eFD",
    NOW,
  );
  await decideQueueEntry(env.DB, queueId, "approved", NOW);
  return queueId;
}

const GOOD = {
  dry: "Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase of $LMT, trade date 2026-06-03, per Senate eFD.\n\nDisclosed 45 days later.",
  sharp: "Jane Roe. $1,000,001 - $5,000,000 into $LMT on 2026-06-03, public 2026-07-18, per Senate eFD.\n\nRead that lag again.",
  commentary:
    "Senate PTR: Jane Roe bought $1,000,001 - $5,000,000 of $LMT on 2026-06-03 and the record went public 2026-07-18, per Senate eFD. The disclosure took 45 days. The trade is legal, the lag is legal, and the lag is also the entire story the filing tells.",
};

describe("prompt assembly", () => {
  it("eligibleBeats returns only gate-passing beats, never signature tier", () => {
    const beats = eligibleBeats("CONGRESS_PTR", PTR_PAYLOAD);
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.join("\n")).toContain("Disclosed 45 days later.");
    // lag >= 30 escalation is eligible at 45; the 40-day one too
    expect(beats.join("\n")).toContain("Read that lag again.");
    // A gate the payload does NOT satisfy stays out — no paper-filing beat.
    expect(beats.join("\n")).not.toContain("Paper filing");
  });

  it("the payload is the only fact source and the prompt says so", () => {
    const p = buildPrompt("CONGRESS_PTR", PTR_PAYLOAD, "https://x/1", [EXEMPLAR]);
    expect(p.user).toContain("ONLY source of facts");
    expect(p.user).toContain("never do arithmetic");
    expect(p.system).toContain("OWNER EXEMPLARS");
    expect(p.system).toContain(EXEMPLAR.text);
    expect(p.system).toContain("CONGRESS PTR, MEASURED NOTES");
  });

  it("parseVariants survives fences and prose around the JSON", () => {
    const wrapped = "Sure! Here you go:\n```json\n" + JSON.stringify(GOOD) + "\n```";
    expect(parseVariants(wrapped)).toEqual(GOOD);
    expect(parseVariants("no json at all")).toEqual({});
  });
});

describe("runGeneration end-to-end", () => {
  it("does nothing unconfigured (no key = queue holds, no crash)", async () => {
    await seedApproved("P-unconfig");
    const before = orCalls;
    await runGeneration(env, NOW); // plain env: no OPENROUTER_* set
    expect(orCalls).toBe(before);
  });

  it("THE EXEMPLAR GATE: no exemplar -> no LLM call, marker row, template stands", async () => {
    const qid = await seedApproved("P-gate");
    const before = orCalls;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [] });
    expect(orCalls).toBe(before); // the model was never consulted
    const marker = await env.DB.prepare(`SELECT variant, status FROM generations WHERE queue_id = ?1`).bind(qid).first();
    expect(marker).toMatchObject({ variant: "none", status: "skipped_no_exemplar" });
  });

  it("happy path: three valid variants stored, one call", async () => {
    const qid = await seedApproved("P-happy");
    nextReply = () => GOOD;
    const before = orCalls;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(orCalls).toBe(before + 1);
    const rows = await env.DB.prepare(
      `SELECT variant, status FROM generations WHERE queue_id = ?1 ORDER BY variant`,
    ).bind(qid).all<{ variant: string; status: string }>();
    expect(rows.results).toEqual([
      { variant: "commentary", status: "valid" },
      { variant: "dry", status: "valid" },
      { variant: "sharp", status: "valid" },
    ]);
  });

  it("a fabricated number is rejected, regenerated once, and the audit trail shows both attempts", async () => {
    const qid = await seedApproved("P-fab");
    let call = 0;
    nextReply = () => {
      call += 1;
      return call === 1
        ? { ...GOOD, dry: "Senate PTR: Jane Roe, $9,999,999 purchase of $LMT, per Senate eFD." } // 9,999,999 is from nowhere
        : GOOD;
    };
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    const drys = await env.DB.prepare(
      `SELECT attempt, status FROM generations WHERE queue_id = ?1 AND variant = 'dry' ORDER BY attempt`,
    ).bind(qid).all<{ attempt: number; status: string }>();
    expect(drys.results).toEqual([
      { attempt: 1, status: "rejected:number" },
      { attempt: 2, status: "valid" },
    ]);
  });

  it("every variant failing twice falls back to the template, loudly recorded", async () => {
    const qid = await seedApproved("P-fall");
    nextReply = () => ({
      dry: "The senator knew exactly what was coming, per Senate eFD.", // imputed knowledge... but caught as entity? 'The'? Actually caught by number/entity? Ensure a definite failure: fabricated number
      sharp: "Up 900% since the trade, per Senate eFD.",
      commentary: "They knew. Everyone knew. The filing proves nothing else, per Senate eFD.",
    });
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    const fb = await env.DB.prepare(
      `SELECT variant, status, text FROM generations WHERE queue_id = ?1 AND status = 'fallback_template'`,
    ).bind(qid).first<{ variant: string; status: string; text: string }>();
    expect(fb).not.toBeNull();
    expect(fb!.variant).toBe("none");
    expect(fb!.text).toContain("per Senate eFD"); // the template draft, standing
  });

  it("an over-budget stale draft is re-rendered for the fallback path", async () => {
    // A draft rendered under the old 500 budget: 300 x's + attribution.
    const longDraft = `${"x".repeat(300)}, per Nasdaq`;
    const qid = await seedApproved(
      "P-stale",
      { symbol: "YYAI", reasonCode: "LUDP", reasonText: "Volatility Trading Pause", haltTimeEtShort: "10:16" },
      "HALT",
      longDraft,
    );
    nextReply = () => ({}); // model returns nothing usable -> fallback path
    await runGeneration(genEnv(), NOW, undefined, {
      exemplars: [{ archetype: "HALT" as ArchetypeId, text: "HALT: STKH. News Pending, 19:50 ET, per Nasdaq.\n\nPending is the whole disclosure." }],
    });
    const fb = await env.DB.prepare(
      `SELECT text FROM generations WHERE queue_id = ?1 AND status = 'fallback_template'`,
    ).bind(qid).first<{ text: string }>();
    expect(fb).not.toBeNull();
    // The stored fallback is NOT the stale 300-char draft: it was re-rendered
    // under the current 280 budget by the same engine that made the original.
    expect(fb!.text.length).toBeLessThanOrEqual(280);
    expect(fb!.text).toContain("per Nasdaq");
  });

  it("auth failure alerts once and pauses the run instead of burning the queue", async () => {
    await seedApproved("P-auth1");
    await seedApproved("P-auth2");
    nextStatus = 401;
    try {
      const before = orCalls;
      await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
      // Paused after the FIRST 401: the second queue row was never attempted.
      expect(orCalls).toBe(before + 1);
      expect(TGRAM.calls.some((c) => c.includes("OpenRouter key"))).toBe(true);
    } finally {
      nextStatus = 200;
    }
  });
});
