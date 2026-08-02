import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPrompt, eligibleBeats, runGeneration, MAX_GENERATIONS_PER_RUN } from "../src/rag/generate";
import { parseVariants } from "../src/rag/openrouter";
import { registerJobs } from "../src/jobs";
import { registry } from "../src/dispatch";
import { newTickBudget } from "../src/lib/budget";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { iso } from "../src/lib/time";
import type { ArchetypeId } from "../src/templates/types";

const NOW = new Date("2026-07-28T15:00:00Z");

const PTR_PAYLOAD = {
  member: "Jane Roe",
  chamber: "senate", // lowercase: the canonical key in PR #53's attribution map
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
let nextStatus = 200; // persisted interceptors shadow later ones: ONE dynamic interceptor serves all cases
let nextFinish = "stop";
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
          ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(nextReply()) }, finish_reason: nextFinish }] })
          : JSON.stringify({ error: { message: "upstream says no", code: nextStatus } });
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

beforeEach(() => {
  // Deltas would also work; resetting removes a class of order-dependence
  // outright (finding #37).
  TGRAM.calls.length = 0;
  nextStatus = 200;
  nextFinish = "stop";
  nextReply = () => ({});
});

async function seedApproved(
  externalId: string,
  payload: object = PTR_PAYLOAD,
  archetype = "CONGRESS_PTR",
  opts: { draft?: string; source?: string; edited?: string; decidedAt?: Date } = {},
): Promise<number> {
  const item = await insertItem(env.DB, {
    source: opts.source ?? "senate_ptr",
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
    opts.draft ?? "Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase, trade date 2026-06-03, per Senate eFD",
    NOW,
  );
  await decideQueueEntry(env.DB, queueId, "approved", opts.decidedAt ?? NOW);
  if (opts.edited) {
    await env.DB.prepare(`UPDATE queue SET state = 'edited', edited_text = ?1 WHERE id = ?2`).bind(opts.edited, queueId).run();
  }
  return queueId;
}

const GOOD = {
  dry: "Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase of $LMT, trade date June 3, per Senate eFD.\n\nDisclosed 45 days later.",
  sharp: "Jane Roe. $1,000,001 - $5,000,000 into $LMT on June 3, public July 18, per Senate eFD.\n\nRead that lag again.",
  commentary:
    "Senate PTR: Jane Roe bought $1,000,001 - $5,000,000 of $LMT, trade date June 3, public July 18, per Senate eFD.\n\nThe disclosure took 45 days. The trade is lawful, the lag is lawful, and the lag is also the only story this filing has to tell.",
};

describe("prompt assembly", () => {
  it("eligibleBeats returns only gate-passing beats, never signature tier", () => {
    const beats = eligibleBeats("CONGRESS_PTR", PTR_PAYLOAD);
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.join("\n")).toContain("Disclosed 45 days later.");
    expect(beats.join("\n")).toContain("Read that lag again.");
    expect(beats.join("\n")).not.toContain("Paper filing");
  });

  it("the payload is the only fact source; no URL ever enters the prompt", () => {
    const p = buildPrompt("CONGRESS_PTR", PTR_PAYLOAD, [EXEMPLAR]);
    // Without grounding, the whitelist contract names the payload alone.
    expect(p.user).toContain("must appear in the payload;");
    expect(p.user).not.toContain("SOURCE DOCUMENT");
    expect(p.user).not.toContain("LAKE CONTEXT");
    expect(p.user).toContain("never do arithmetic");
    expect(p.user).not.toMatch(/https?:\/\//); // finding #10: the model gets no URL at all
    expect(p.system).toContain("OWNER EXEMPLARS");
    expect(p.system).toContain(EXEMPLAR.text);
    // Exemplars appear EXACTLY once (finding #24: two homes doubled them).
    expect(p.system.split(EXEMPLAR.text).length - 1).toBe(1);
    expect(p.system).toContain("CONGRESS PTR, MEASURED NOTES");
  });

  it("commentary leads the task spec and the resolved citation is stated verbatim (p4-00b)", () => {
    const p = buildPrompt("CONGRESS_PTR", PTR_PAYLOAD, [EXEMPLAR]);
    // The first live run (queue #918) proved the old prompt's two gaps: dry
    // led the spec, and the model was never told WHICH citation validates.
    expect(p.user.indexOf('"commentary"')).toBeLessThan(p.user.indexOf('"dry"'));
    expect(p.user).toContain("THE deliverable");
    expect(p.user).toContain('ends with exactly "per Senate eFD"');
  });

  it("rejection feedback rides into the retry prompt (finding #25)", () => {
    const p = buildPrompt("CONGRESS_PTR", PTR_PAYLOAD, [EXEMPLAR], ['dry: "$9,999,999" does not appear in the payload']);
    expect(p.user).toContain("PREVIOUS ATTEMPT WAS REJECTED");
    expect(p.user).toContain("$9,999,999");
  });

  it("parseVariants survives fences, prose, braces in prose, and broken outer JSON", () => {
    const wrapped = "Sure! Here you go:\n```json\n" + JSON.stringify(GOOD) + "\n```";
    expect(parseVariants(wrapped)).toEqual(GOOD);
    // Braces in the surrounding prose (finding #23) no longer kill the parse.
    const braced = 'The format {"dry": "..."} you asked for:\n' + JSON.stringify(GOOD);
    expect(parseVariants(braced)).toEqual(GOOD);
    // Broken outer JSON, salvage per key.
    const broken = `{"dry": ${JSON.stringify(GOOD.dry)}, "sharp": ${JSON.stringify(GOOD.sharp)}, "commentary": ${JSON.stringify(GOOD.commentary)},}`;
    expect(parseVariants(broken).dry).toBe(GOOD.dry);
    expect(parseVariants("no json at all")).toEqual({});
  });
});

describe("the job is actually wired (finding #29 — the park's drift family)", () => {
  it("registerJobs registers 'generation' and migration 0027 seeded its row", async () => {
    registerJobs();
    expect(registry["generation"]).toBeDefined();
    const row = await env.DB.prepare(`SELECT cadence_profile, enabled, priority FROM jobs WHERE name = 'generation'`).first<{
      cadence_profile: string;
      enabled: number;
      priority: number;
    }>();
    expect(row).toEqual({ cadence_profile: "every_5m", enabled: 1, priority: 30 });
  });
});

describe("runGeneration end-to-end", () => {
  it("does nothing unconfigured (no key = queue holds, no crash)", async () => {
    await seedApproved("P-unconfig");
    const before = orCalls;
    await runGeneration(env, NOW);
    expect(orCalls).toBe(before);
  });

  it("THE EXEMPLAR GATE: no exemplar -> no LLM call, marker row, template stands", async () => {
    const qid = await seedApproved("P-gate");
    const before = orCalls;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [] });
    expect(orCalls).toBe(before);
    const marker = await env.DB.prepare(`SELECT variant, status FROM generations WHERE queue_id = ?1`).bind(qid).first();
    expect(marker).toMatchObject({ variant: "none", status: "skipped_no_exemplar" });
  });

  it("happy path: three valid variants with REAL shape hashes, one call", async () => {
    const qid = await seedApproved("P-happy");
    nextReply = () => GOOD;
    const before = orCalls;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(orCalls).toBe(before + 1);
    const rows = await env.DB.prepare(
      `SELECT variant, status, skeleton_hash, opener_hash FROM generations WHERE queue_id = ?1 ORDER BY variant`,
    ).bind(qid).all<{ variant: string; status: string; skeleton_hash: string; opener_hash: string }>();
    expect(rows.results.map((r) => ({ variant: r.variant, status: r.status }))).toEqual([
      { variant: "commentary", status: "valid" },
      { variant: "dry", status: "valid" },
      { variant: "sharp", status: "valid" },
    ]);
    // Finding #14: the collision history is only as real as these columns.
    for (const r of rows.results) {
      expect(r.skeleton_hash).toMatch(/^[0-9a-f]{8}$/);
      expect(r.opener_hash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("a fabricated number is rejected, regenerated once, audit shows both attempts", async () => {
    const qid = await seedApproved("P-fab");
    let call = 0;
    nextReply = () => {
      call += 1;
      return call === 1 ? { ...GOOD, dry: "Senate PTR: Jane Roe, $9,999,999 purchase of $LMT, per Senate eFD." } : GOOD;
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

  it("all variants failing on doctrine falls back to a register-checked template (per-variant reasons asserted)", async () => {
    const qid = await seedApproved("P-fall");
    nextReply = () => ({
      dry: "The senator knew exactly what was coming, per Senate eFD.", // motive
      sharp: "Up 900% since the trade, per Senate eFD.", // fabricated percent
      commentary:
        "They knew. Everyone knew. The filing proves nothing else, and the lag speaks for itself here, which anyone can see plainly in the record as it stands filed today, per Senate eFD.", // motive
    });
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    // Finding #28: assert each variant's ACTUAL failing rule, not a guess.
    const byVariant = await env.DB.prepare(
      `SELECT variant, status FROM generations WHERE queue_id = ?1 AND attempt = 1 AND variant <> 'none' ORDER BY variant`,
    ).bind(qid).all<{ variant: string; status: string }>();
    expect(byVariant.results).toEqual([
      { variant: "commentary", status: "rejected:motive" },
      { variant: "dry", status: "rejected:motive" },
      { variant: "sharp", status: "rejected:number" },
    ]);
    const fb = await env.DB.prepare(
      `SELECT variant, status, text FROM generations WHERE queue_id = ?1 AND status = 'fallback_template'`,
    ).bind(qid).first<{ variant: string; status: string; text: string }>();
    expect(fb).not.toBeNull();
    expect(fb!.variant).toBe("none");
    expect(fb!.text).toContain("per Senate eFD");
  });

  it("the owner's EDIT is preferred as fallback when it fits (finding #31)", async () => {
    const edited = "Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase, trade date 2026-06-03, per Senate eFD. Owner-tightened.";
    const qid = await seedApproved("P-edit", PTR_PAYLOAD, "CONGRESS_PTR", { edited });
    nextReply = () => ({}); // model useless -> fallback path
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    const fb = await env.DB.prepare(
      `SELECT text FROM generations WHERE queue_id = ?1 AND status = 'fallback_template'`,
    ).bind(qid).first<{ text: string }>();
    expect(fb!.text).toBe(edited);
  });

  it("an over-budget stale draft is re-rendered and the rotation ledger updated", async () => {
    const longDraft = `${"x".repeat(300)}, per Nasdaq`;
    const qid = await seedApproved(
      "P-stale",
      { symbol: "YYAI", reasonCode: "LUDP", reasonText: "Volatility Trading Pause", haltTimeEtShort: "10:16" },
      "HALT",
      { draft: longDraft },
    );
    nextReply = () => ({});
    await runGeneration(genEnv(), NOW, undefined, {
      exemplars: [{ archetype: "HALT" as ArchetypeId, text: "HALT: STKH. News Pending, 19:50 ET, per Nasdaq.\n\nPending is the whole disclosure." }],
    });
    const fb = await env.DB.prepare(
      `SELECT text FROM generations WHERE queue_id = ?1 AND status = 'fallback_template'`,
    ).bind(qid).first<{ text: string }>();
    expect(fb).not.toBeNull();
    expect(fb!.text.length).toBeLessThanOrEqual(280);
    expect(fb!.text).toContain("per Nasdaq");
    // Finding #21a: the queue row's rotation fields reflect the re-render.
    const q = await env.DB.prepare(`SELECT skeleton_id FROM queue WHERE id = ?1`).bind(qid).first<{ skeleton_id: string | null }>();
    expect(q!.skeleton_id).toMatch(/^halt\./);
  });

  it("a register-failing hand edit that generation cannot rescue is HELD, loudly (finding #12)", async () => {
    // The real near-miss from the poster era: an edit reply of "na".
    const qid = await seedApproved("P-na", PTR_PAYLOAD, "CONGRESS_PTR", { edited: "na" });
    // Empty payload so the rescue re-render also fails.
    await env.DB.prepare(`UPDATE items SET payload = '{}' WHERE id = (SELECT item_id FROM queue WHERE id = ?1)`).bind(qid).run();
    nextReply = () => ({});
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    const held = await env.DB.prepare(
      `SELECT status FROM generations WHERE queue_id = ?1 ORDER BY id DESC LIMIT 1`,
    ).bind(qid).first<{ status: string }>();
    expect(held!.status).toBe("fallback_blocked");
    expect(TGRAM.calls.some((c) => c.includes("held for your edit"))).toBe(true);
  });

  it("a TRUNCATED reply (finish_reason=length) is a transient failure, never a short answer", async () => {
    // The House PDF lesson mechanically: a reply that parses but was cut off
    // is a well-formed lie. The client must throw, the job must record
    // api_error (non-terminal), and the row must retry.
    const qid = await seedApproved("P-trunc");
    nextFinish = "length";
    nextReply = () => GOOD;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    const rows = await env.DB.prepare(`SELECT status FROM generations WHERE queue_id = ?1`).bind(qid).all<{ status: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(rows.results.every((r) => r.status === "api_error")).toBe(true);
  });

  it("transient upstream failure leaves NO terminal row: the row retries next tick (finding #9)", async () => {
    const qid = await seedApproved("P-transient");
    nextStatus = 429;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    const rows = await env.DB.prepare(`SELECT status FROM generations WHERE queue_id = ?1`).bind(qid).all<{ status: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(rows.results.every((r) => r.status === "api_error")).toBe(true);
    // Next tick, upstream healthy: the row IS re-picked and completes.
    nextStatus = 200;
    nextReply = () => GOOD;
    await runGeneration(genEnv(), new Date(NOW.getTime() + 300_000), undefined, { exemplars: [EXEMPLAR] });
    const valid = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM generations WHERE queue_id = ?1 AND status = 'valid'`,
    ).bind(qid).first<{ n: number }>();
    expect(valid!.n).toBe(3);
  });

  it("an EMPTY echo_ngrams alerts loudly instead of silently disabling the check", async () => {
    // It no-opped in production for four days behind a warn line. Absence of
    // data is never evidence of no match.
    await env.KV.delete("echo:empty_alert_sent");
    await env.DB.prepare(`DELETE FROM echo_ngrams`).run();
    await seedApproved("P-echoempty");
    nextReply = () => GOOD;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(TGRAM.calls.some((c) => c.includes("echo_ngrams is empty"))).toBe(true);
  });

  it("auth failure pauses the run after ONE call and alerts once per window (finding #32)", async () => {
    await seedApproved("P-auth1");
    await seedApproved("P-auth2");
    nextStatus = 401;
    const before = orCalls;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(orCalls).toBe(before + 1); // second row never attempted
    expect(TGRAM.calls.filter((c) => c.includes("OpenRouter key")).length).toBe(1);
    // A second run inside the suppression window does not re-alert.
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(TGRAM.calls.filter((c) => c.includes("OpenRouter key")).length).toBe(1);
  });

  it("picker: smoke_test excluded, cap enforced, oldest decided first (finding #38)", async () => {
    await seedApproved("P-smoke", PTR_PAYLOAD, "CONGRESS_PTR", { source: "smoke_test" });
    const older = await seedApproved("P-old", PTR_PAYLOAD, "CONGRESS_PTR", { decidedAt: new Date(NOW.getTime() - 3_600_000) });
    const q2 = await seedApproved("P-mid1");
    const q3 = await seedApproved("P-mid2");
    const newest = await seedApproved("P-new", PTR_PAYLOAD, "CONGRESS_PTR", { decidedAt: new Date(NOW.getTime() + 3_600_000) });
    nextReply = () => GOOD;
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    const touched = await env.DB.prepare(`SELECT DISTINCT queue_id FROM generations ORDER BY queue_id`).all<{ queue_id: number }>();
    const ids = touched.results.map((r) => r.queue_id);
    expect(ids.length).toBe(MAX_GENERATIONS_PER_RUN);
    expect(ids).toContain(older); // oldest decided runs first
    expect(ids).toContain(q2);
    expect(ids).toContain(q3);
    expect(ids).not.toContain(newest); // over the cap this run
    const smoke = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM generations g JOIN queue q ON q.id = g.queue_id JOIN items i ON i.id = q.item_id WHERE i.source = 'smoke_test'`,
    ).first<{ n: number }>();
    expect(smoke!.n).toBe(0);
  });
});

describe("generation and delivery are decoupled (p4-13)", () => {
  it("delivery still runs when generation throws, and the failure still surfaces", async () => {
    // They were awaited in sequence, so a throw skipped delivery entirely —
    // and deliverCards is not generation's downstream step: it delivers every
    // terminal row without a live card, including ones generated on earlier
    // ticks. A persistent throw stranded finished commentary the owner never
    // saw. validateVariant makes D1 calls and is unwrapped, so the throw is
    // reachable today rather than hypothetical.
    registerJobs();
    const handler = registry["generation"]!;

    // The first version of this test threw the IDENTICAL message from both
    // stub paths and asserted only `rejects.toThrow("D1 hiccup")`. That passes
    // whether or not delivery was ever attempted — review proved it by
    // swapping in the pre-PR src/jobs.ts (the plain sequential
    // `await runGeneration(); await deliverCards();`) and watching it stay
    // green. The comment claimed the escaping error identified the path; the
    // code made the two indistinguishable.
    //
    // So: distinct messages per path, and a record of the SQL actually
    // attempted. deliverCards' opening query is the only one that selects
    // `stale_card`, which makes it a reliable fingerprint.
    const seen: string[] = [];
    const DELIVERY_SQL = "stale_card";
    const poisoned = {
      ...env,
      // Set explicitly: deliverCards returns early without these, which would
      // make the delivery assertion below fail for a reason unrelated to the
      // decoupling. Better a confusing red than a silent green.
      TELEGRAM_BOT_TOKEN: "TEST:TOKEN",
      TELEGRAM_CHAT_ID: "424242",
      OPENROUTER_API_KEY: "k",
      OPENROUTER_MODEL: "m",
      DB: {
        prepare(sql: string) {
          seen.push(sql);
          throw new Error(
            sql.includes(DELIVERY_SQL) ? "D1 hiccup in deliverCards" : "D1 hiccup in collisionCheck",
          );
        },
        batch() {
          seen.push("batch()");
          throw new Error("D1 hiccup in collisionCheck");
        },
      },
    } as never;

    await expect(handler(poisoned, NOW, newTickBudget())).rejects.toThrow(
      // Delivery's error, not generation's. In the decoupled handler
      // deliverCards runs AFTER the generation catch and its throw propagates
      // directly, so this message can only escape if delivery was attempted.
      // Under the pre-PR sequential version the generation throw escapes first
      // and this assertion goes red.
      "D1 hiccup in deliverCards",
    );

    // Belt and braces, and the assertion that survives a refactor of the
    // error messages: both paths were actually entered, generation first.
    const generationAttempted = seen.findIndex((s) => !s.includes(DELIVERY_SQL));
    const deliveryAttempted = seen.findIndex((s) => s.includes(DELIVERY_SQL));
    expect(generationAttempted).toBeGreaterThanOrEqual(0);
    expect(deliveryAttempted).toBeGreaterThanOrEqual(0);
    expect(deliveryAttempted).toBeGreaterThan(generationAttempted);
  });
});
