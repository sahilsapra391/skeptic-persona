import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import SINGLE from "./fixtures/house-ptr-single.text.fixture?raw";
import { INGEST_PATH } from "../src/ingestRelay";
import { SOURCE as HOUSE_SOURCE } from "../src/ingesters/housePtr";
import { insertItem, SCORE_LOG_ONLY } from "../src/lib/db";

const URL_BASE = "https://worker.local";
const SECRET = "test-ingest-secret";
const NOW = new Date("2026-07-28T14:00:00.000Z");

function post(body: unknown): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${INGEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Ingest-Secret": SECRET },
    body: JSON.stringify(body),
  });
}

async function seed(docId: string) {
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
    NOW,
  );
}

describe("probe: replay of the same house bundle", () => {
  it("reports how many queue rows exist after two identical POSTs", async () => {
    await seed("30000100");
    const r1 = await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "30000100", text: SINGLE }] }) });
    const b1 = await r1.json();
    const r2 = await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "30000100", text: SINGLE }] }) });
    const b2 = await r2.json();

    const item = await env.DB.prepare(`SELECT id, status FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:30000100`)
      .first<{ id: number; status: string }>();
    const rows = await env.DB.prepare(`SELECT id, state, draft_text FROM queue WHERE item_id = ?1`)
      .bind(item!.id)
      .all<{ id: number; state: string; draft_text: string }>();

    console.log("PROBE post1", JSON.stringify(b1));
    console.log("PROBE post2", JSON.stringify(b2));
    console.log("PROBE item", JSON.stringify(item));
    console.log("PROBE queue rows", JSON.stringify(rows.results));
    expect(true).toBe(true);
  });

  it("probes replay AFTER approval (state != pending)", async () => {
    await seed("30000200");
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "30000200", text: SINGLE }] }) });
    const item = await env.DB.prepare(`SELECT id, status FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:30000200`)
      .first<{ id: number; status: string }>();
    // Simulate the owner approving and the poster posting.
    await env.DB.prepare(`UPDATE queue SET state = 'approved' WHERE item_id = ?1`).bind(item!.id).run();
    await env.DB.prepare(`UPDATE items SET status = 'posted' WHERE id = ?1`).bind(item!.id).run();

    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "30000200", text: SINGLE }] }) });
    const after = await env.DB.prepare(`SELECT id, status FROM items WHERE id = ?1`)
      .bind(item!.id)
      .first<{ id: number; status: string }>();
    const rows = await env.DB.prepare(`SELECT id, state FROM queue WHERE item_id = ?1`)
      .bind(item!.id)
      .all<{ id: number; state: string }>();
    console.log("PROBE2 item after", JSON.stringify(after));
    console.log("PROBE2 queue rows", JSON.stringify(rows.results));
    expect(true).toBe(true);
  });
});
