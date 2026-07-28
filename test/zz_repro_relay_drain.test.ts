import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import SINGLE from "./fixtures/house-ptr-single.text.fixture?raw";
import { INGEST_PATH, PENDING_PATH } from "../src/ingestRelay";
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

function pending(): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${PENDING_PATH}`, { headers: { "X-Ingest-Secret": SECRET } });
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
        member: `Member ${docId}`,
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

async function statuses(ids: string[]) {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const r = await env.DB.prepare(`SELECT status FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:${id}`)
      .first<{ status: string }>();
    out[id] = r?.status ?? "MISSING";
  }
  return out;
}

describe("repro: >3 fresh house filings in one relay bundle", () => {
  it("shows what happens to the surplus", async () => {
    const ids = ["30000001", "30000002", "30000003", "30000004", "30000005"];
    for (const id of ids) await seed(id);

    const res = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: ids.map((docId) => ({ docId, text: SINGLE })) }),
    });
    const body = await res.json();
    console.log("RELAY RESPONSE", JSON.stringify(body));
    console.log("STATUSES AFTER BUNDLE", JSON.stringify(await statuses(ids)));

    const pend = (await (await pending()).json()) as { docs: { docId: string }[] };
    console.log("PENDING AFTER BUNDLE", JSON.stringify(pend.docs.map((d) => d.docId)));

    // Now a LATER relay POST arrives with one brand-new document.
    await seed("30000009");
    const res2 = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: [{ docId: "30000009", text: SINGLE }] }),
    });
    console.log("SECOND RELAY RESPONSE", JSON.stringify(await res2.json()));
    console.log("STATUSES AFTER SECOND", JSON.stringify(await statuses([...ids, "30000009"])));

    // Count queue rows
    const q = await env.DB.prepare(`SELECT COUNT(*) AS n FROM queue`).first<{ n: number }>();
    console.log("QUEUE ROWS", q?.n);
    expect(true).toBe(true);
  });
});
