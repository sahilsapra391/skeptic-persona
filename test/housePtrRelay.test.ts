import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import MULTI from "./fixtures/house-ptr-multi.text.fixture?raw";
import SINGLE from "./fixtures/house-ptr-single.text.fixture?raw";
import { INGEST_PATH, PENDING_PATH } from "../src/ingestRelay";
import { pollHousePtr, SOURCE as HOUSE_SOURCE } from "../src/ingesters/housePtr";
import { insertItem, SCORE_LOG_ONLY } from "../src/lib/db";

const URL_BASE = "https://worker.local";
const SECRET = "test-ingest-secret";

function post(body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Ingest-Secret"] = secret;
  return SELF.fetch(`${URL_BASE}${INGEST_PATH}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function pending(secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["X-Ingest-Secret"] = secret;
  return SELF.fetch(`${URL_BASE}${PENDING_PATH}`, { headers });
}

/** Seed a discovery-level House item exactly as pollHousePtr would. */
async function seedIndexRow(
  docId: string,
  now: Date,
  over: Partial<{ efiled: boolean; filedDate: string; member: string }> = {},
) {
  await insertItem(
    env.DB,
    {
      source: HOUSE_SOURCE,
      externalId: docId,
      category: "congress",
      eventAt: "2026-07-27T00:00:00.000Z",
      sourceUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`,
      payload: {
        member: over.member ?? "Hon. Example Member",
        stateDst: "CA01",
        filedDate: over.filedDate ?? "07/27/2026",
        efiled: over.efiled ?? true,
        transactions: null,
      },
      score: SCORE_LOG_ONLY,
      status: "logged",
    },
    now,
  );
}

const NOW = new Date("2026-07-28T14:00:00.000Z");

async function payloadOf(docId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT payload FROM items WHERE dedup_key = ?1`)
    .bind(`${HOUSE_SOURCE}:${docId}`)
    .first<{ payload: string }>();
  return JSON.parse(row!.payload) as Record<string, unknown>;
}

describe("house_ptr pending endpoint", () => {
  it("requires the same secret the POST endpoint does", async () => {
    expect((await pending(null)).status).toBe(401);
    expect((await pending("wrong")).status).toBe(401);
    // Equal length, last byte differs: exercises the compare, not the
    // length-mismatch early return.
    expect((await pending("test-ingest-secreT")).status).toBe(401);
  });

  it("lists only e-filed documents whose transactions are still unread", async () => {
    await seedIndexRow("20260001", NOW);
    await seedIndexRow("20260002", NOW, { efiled: false }); // paper scan, no text layer
    await seedIndexRow("20260003", NOW);

    // Already extracted: must not come back.
    await env.DB.prepare(
      `UPDATE items SET payload = json_set(payload, '$.transactions', json('[]')) WHERE external_id = ?1`,
    )
      .bind("20260003")
      .run();

    const body = (await (await pending()).json()) as { docs: { docId: string; url: string }[] };
    expect(body.docs.map((d) => d.docId)).toEqual(["20260001"]);
    // The URL is the one already stored, not one the courier rebuilds.
    expect(body.docs[0]!.url).toContain("/ptr-pdfs/2026/20260001.pdf");
  });

  it("stops offering a document that has failed extraction too many times", async () => {
    await seedIndexRow("20260010", NOW);
    for (let i = 0; i < 3; i++) {
      // A scanned PDF yields no text; without a cap this is fetched daily forever.
      const res = await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260010", text: "" }] }) });
      expect(res.status).toBe(200);
    }
    expect(((await payloadOf("20260010")).pdfAttempts as number)).toBe(3);

    const body = (await (await pending()).json()) as { docs: { docId: string }[] };
    expect(body.docs.map((d) => d.docId)).not.toContain("20260010");
  });
});

describe("house_ptr extraction relay", () => {
  it("merges transactions, drafts, and queues a fresh filing", async () => {
    await seedIndexRow("20260100", NOW);
    const res = await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260100", text: MULTI }] }) });
    expect(res.status).toBe(200);

    const p = await payloadOf("20260100");
    expect((p.transactions as unknown[]).length).toBe(16);
    expect(p.chamber).toBe("house");
    expect(p.factLine).toContain("House PTR:");
    expect(p.who).toBe("Hon. Example Member");

    // The relay drains in the same request, so a fresh filing lands in the
    // approval queue rather than sitting at 'new' waiting for a tick.
    const row = await env.DB.prepare(`SELECT id, status FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:20260100`)
      .first<{ id: number; status: string }>();
    expect(row?.status).toBe("queued");

    const card = await env.DB.prepare(`SELECT archetype, draft_text FROM queue WHERE item_id = ?1`)
      .bind(row!.id)
      .first<{ archetype: string; draft_text: string }>();
    expect(card?.archetype).toBe("CONGRESS_PTR");
    // The bug this whole change exists for: a House filing citing the Senate.
    expect(card?.draft_text).toContain("per House Clerk");
    expect(card?.draft_text).not.toContain("Senate eFD");
  });

  it("never derives a midpoint from an amount band", async () => {
    await seedIndexRow("20260101", NOW);
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260101", text: MULTI }] }) });
    const p = await payloadOf("20260101");
    for (const t of p.transactions as { amount: string }[]) {
      expect(t.amount).toMatch(/^\$[\d,]+ - \$[\d,]+$/);
    }
    expect(String(p.factLine)).toContain(" - $");
  });

  it("refuses to queue an extraction the document says is incomplete", async () => {
    await seedIndexRow("20260102", NOW);
    // Amputate the last transaction's amount band while leaving its date
    // marker intact: the strict parser reads 15, the document still
    // advertises 16. This is the exact shape of the Home Depot regression.
    const truncated = MULTI.slice(0, MULTI.lastIndexOf("$")) + "$";

    const res = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: [{ docId: "20260102", text: truncated }] }),
    });
    expect(res.status).toBe(200);

    const p = await payloadOf("20260102");
    // Fails CLOSED: no partial trade list reaches the queue, because a post
    // listing 15 of 16 trades reads as complete and is not.
    expect(p.transactions).toBeNull();
    expect(p.pdfLastFailure).toBe("incomplete");

    const row = await env.DB.prepare(`SELECT status FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:20260102`)
      .first<{ status: string }>();
    expect(row?.status).toBe("logged");
  });

  it("does not invent an item for a document it never indexed", async () => {
    const res = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: [{ docId: "99999999", text: SINGLE }] }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE external_id = ?1`)
      .bind("99999999")
      .first<{ n: number }>();
    // An item created here would have no member and no filing date; there is
    // nothing to attribute, so it is reported rather than fabricated.
    expect(row?.n).toBe(0);
  });

  it("lakes a stale filing instead of interrupting anyone", async () => {
    await seedIndexRow("20260103", NOW, { filedDate: "01/05/2026" });
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260103", text: SINGLE }] }) });
    const row = await env.DB.prepare(`SELECT status FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:20260103`)
      .first<{ status: string }>();
    expect(row?.status).toBe("logged");
    expect((await payloadOf("20260103")).transactions).not.toBeNull();
  });

  it("rejects a malformed bundle loudly rather than accepting nothing", async () => {
    expect((await post({ source: HOUSE_SOURCE, body: JSON.stringify({}) })).status).toBe(422);
    expect((await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: 1 }] }) })).status).toBe(422);
    expect((await post({ source: HOUSE_SOURCE, body: "not json" })).status).toBe(422);
  });
});

describe("house_ptr items past the relay's drain limit still reach the queue", () => {
  it("pollHousePtr drains the backlog the relay could not enqueue", async () => {
    // THE BUG: drain() enqueues at most 3 per relay request, and house_ptr
    // was the one congressional source with no second drain — pollHousePtr
    // never looked at status='new'. Surplus postable filings sat unqueued
    // AND invisible to the pending endpoint (their transactions are set).
    const docs = ["20260200", "20260201", "20260202", "20260203", "20260204"];
    for (const d of docs) await seedIndexRow(d, NOW);

    const res = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: docs.map((d) => ({ docId: d, text: SINGLE })) }),
    });
    expect(res.status).toBe(200);

    const stranded = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items WHERE source = ?1 AND status = 'new' AND external_id IN (${docs
        .map(() => "?")
        .join(",")})`,
    )
      .bind(HOUSE_SOURCE, ...docs)
      .first<{ n: number }>();
    // The relay drains 3; the rest are the backlog this test exists for.
    expect(stranded!.n).toBeGreaterThan(0);

    await pollHousePtr(env as never, NOW);

    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items WHERE source = ?1 AND status = 'new' AND external_id IN (${docs
        .map(() => "?")
        .join(",")})`,
    )
      .bind(HOUSE_SOURCE, ...docs)
      .first<{ n: number }>();
    expect(after!.n).toBeLessThan(stranded!.n);
  });
});
