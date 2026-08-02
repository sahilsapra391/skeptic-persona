import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runGeneration } from "../src/rag/generate";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { iso } from "../src/lib/time";
import type { ArchetypeId } from "../src/templates/types";

// THE SUPPRESSION ORDERING, ATTACKED RATHER THAN TRUSTED.
//
// The comment on this path claims the KV suppression key is written only on
// CONFIRMED DELIVERY, so an undelivered alert retries instead of being
// swallowed for 24h. That is a bug this repo previously SHIPPED on the echo
// alert, and "a bug I avoided because I'd shipped it before" is exactly the
// claim least worth taking on trust.

const KV_KEY = "record:unmeasurable_alert_sent";
const NOW = new Date("2026-08-02T16:00:00Z");
const EXEMPLAR = {
  archetype: "CONGRESS_PTR" as ArchetypeId,
  text: "Senate PTR: $500,001 - $1,000,000 sale, trade date May 2, per Senate eFD.\n\nDisclosed 41 days later.",
};

let tgMode: "ok" | "non2xx" | "throw" = "ok";
const sends: string[] = [];

const genEnv = () =>
  Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
    OPENROUTER_API_KEY: "TESTKEY",
    OPENROUTER_MODEL: "test/model",
  });

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://openrouter.ai")
    .intercept({ path: /\/chat\/completions/, method: "POST" })
    .reply(() => ({
      statusCode: 200,
      data: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ dry: "x", sharp: "y", commentary: "z" }) } }] }),
    }))
    .persist();
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ path: /\/botTEST:TOKEN\/sendMessage/, method: "POST" })
    .reply((opts) => {
      if (tgMode === "throw") throw new Error("socket hang up");
      if (tgMode === "non2xx") return { statusCode: 500, data: JSON.stringify({ ok: false, error_code: 500, description: "boom" }) };
      sends.push(String(opts.body));
      return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 1 } }) };
    })
    .persist();
});

beforeEach(async () => {
  sends.length = 0;
  tgMode = "ok";
  await env.KV.delete(KV_KEY);
});

/** A queue row whose canonical render has NO fact block — the unmeasurable case. */
async function unmeasurableRow(ext: string): Promise<number> {
  const item = await insertItem(env.DB, {
    source: "senate_ptr", externalId: ext, category: "congress", eventAt: iso(NOW),
    sourceUrl: `https://efdsearch.senate.gov/${ext}`,
    payload: { member: "Jane Roe", lagDays: 45, chamber: "senate" }, score: SCORE_POSTABLE,
  });
  const qid = await createQueueEntry(env.DB, item.id ?? 0, "CONGRESS_PTR", "   ", NOW);
  await decideQueueEntry(env.DB, qid, "approved", NOW);
  return qid;
}

describe("the unmeasurable alert's suppression key", () => {
  it("is NOT written when the send returns non-2xx", async () => {
    await unmeasurableRow("alert-non2xx");
    tgMode = "non2xx";
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(await env.KV.get(KV_KEY), "an undelivered alert must retry, not be swallowed for 24h").toBeNull();
  });

  it("is NOT written when the send THROWS", async () => {
    await unmeasurableRow("alert-throw");
    tgMode = "throw";
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(await env.KV.get(KV_KEY)).toBeNull();
  });

  it("IS written on confirmed delivery, and a second trigger is suppressed", async () => {
    await unmeasurableRow("alert-ok-1");
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(await env.KV.get(KV_KEY)).not.toBeNull();
    // Count THIS alert, not every message the run happens to send. The first
    // version asserted on sends.length and failed at 4-vs-3 because a run also
    // emits other alerts — my assertion was wrong, not the code.
    const unmeasurableAlerts = (): number => sends.filter((s) => s.includes("no fact block")).length;
    expect(unmeasurableAlerts()).toBe(1);

    await unmeasurableRow("alert-ok-2");
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(unmeasurableAlerts(), "suppressed within the window").toBe(1);
  });

  it("a THIN record does not alert — alerting on a normal outcome trains you to ignore the channel", async () => {
    const item = await insertItem(env.DB, {
      source: "senate_ptr", externalId: "alert-thin", category: "congress", eventAt: iso(NOW),
      sourceUrl: "https://efdsearch.senate.gov/alert-thin",
      payload: { member: "Jane Roe", lagDays: 45, chamber: "senate" }, score: SCORE_POSTABLE,
    });
    // A fact block so long that fact + shortest take exceeds 280: no_room.
    const qid = await createQueueEntry(env.DB, item.id ?? 0, "CONGRESS_PTR", "x".repeat(260), NOW);
    await decideQueueEntry(env.DB, qid, "approved", NOW);
    await runGeneration(genEnv(), NOW, undefined, { exemplars: [EXEMPLAR] });
    expect(sends.some((s) => s.includes("no fact block")), "too_thin must stay silent").toBe(false);
    expect(await env.KV.get(KV_KEY)).toBeNull();
  });
});
