import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import SINGLE from "./fixtures/house-ptr-single.text.fixture?raw";
import { INGEST_PATH, PENDING_PATH } from "../src/ingestRelay";
import { SOURCE as HOUSE_SOURCE } from "../src/ingesters/housePtr";
import { insertItem, SCORE_LOG_ONLY } from "../src/lib/db";

const URL_BASE = "https://worker.local";
const SECRET = "test-ingest-secret";

function post(body: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${INGEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Ingest-Secret": SECRET },
    body: JSON.stringify(body),
  });
}
function pending(): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${PENDING_PATH}`, { headers: { "X-Ingest-Secret": SECRET } });
}

async function seed(docId: string, now: Date) {
  await insertItem(
    env.DB,
    {
      source: HOUSE_SOURCE,
      externalId: docId,
      category: "congress",
      eventAt: "2026-07-27T00:00:00.000Z",
      sourceUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`,
      payload: {
        member: "Hon. Example Member",
        stateDst: "CA01",
        filedDate: "07/27/2026",
        efiled: true,
        transactions: null,
      },
      score: SCORE_LOG_ONLY,
      status: "logged",
    },
    now,
  );
}

const NOW = new Date("2026-07-28T14:00:00.000Z");

async function itemOf(docId: string) {
  return env.DB.prepare(`SELECT id, status, score, payload FROM items WHERE dedup_key = ?1`)
    .bind(`${HOUSE_SOURCE}:${docId}`)
    .first<{ id: number; status: string; score: number; payload: string }>();
}

describe("REFUTE: mid-bundle throw orphan", () => {
  it("reproduces the reviewer's state, then shows the next relay POST drains it", async () => {
    await seed("30000200", NOW);
    await seed("30000201", NOW);

    // ---- Step 1: the reviewer's exact repro.
    const res = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({
        docs: [
          { docId: "30000200", text: SINGLE },
          { docId: 12345, text: SINGLE },
          { docId: "30000201", text: SINGLE },
        ],
      }),
    });
    console.log("STEP1 relay status:", res.status, await res.text());

    const a1 = await itemOf("30000200");
    const b1 = await itemOf("30000201");
    console.log("STEP1 30000200:", a1?.status, a1?.score, "txns:", JSON.parse(a1!.payload).transactions !== null);
    console.log("STEP1 30000201:", b1?.status, "txns:", JSON.parse(b1!.payload).transactions);
    const q1 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM queue WHERE item_id = ?1`).bind(a1!.id).first<{ n: number }>();
    console.log("STEP1 queue rows for 30000200:", q1?.n);

    const pend1 = (await (await pending()).json()) as { docs: { docId: string }[] };
    console.log("STEP1 pending:", pend1.docs.map((d) => d.docId));

    // ---- Step 2: the courier's NEXT run. Pending still contains 30000201
    // (it was never applied), so the job POSTs again with a well-formed bundle.
    const res2 = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: [{ docId: "30000201", text: SINGLE }] }),
    });
    console.log("STEP2 relay status:", res2.status, await res2.text());

    const a2 = await itemOf("30000200");
    const b2 = await itemOf("30000201");
    console.log("STEP2 30000200:", a2?.status);
    console.log("STEP2 30000201:", b2?.status);
    const q2 = await env.DB.prepare(`SELECT id, item_id, archetype, draft_text FROM queue WHERE item_id IN (?1, ?2)`)
      .bind(a2!.id, b2!.id)
      .all<{ id: number; item_id: number; archetype: string; draft_text: string }>();
    console.log("STEP2 queue rows:", JSON.stringify(q2.results.map((r) => ({ item: r.item_id, arch: r.archetype, txt: r.draft_text.slice(0, 60) })), null, 1));
  });

  it("even an empty-docs bundle drains the orphan", async () => {
    await seed("30000300", NOW);
    const r1 = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: [{ docId: "30000300", text: SINGLE }, { docId: 5, text: "x" }] }),
    });
    console.log("EMPTY-CASE step1 status:", r1.status);
    const a = await itemOf("30000300");
    console.log("EMPTY-CASE after failure:", a?.status);

    const r2 = await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [] }) });
    console.log("EMPTY-CASE step2 status:", r2.status, await r2.text());
    const a2 = await itemOf("30000300");
    console.log("EMPTY-CASE after empty POST:", a2?.status);
  });
});
