import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INGEST_PATH, PRESS_BODY_SOURCE, PRESS_PENDING_PATH } from "../src/ingestRelay";
import { insertItem, SCORE_POSTABLE } from "../src/lib/db";

const BASE = "https://worker.local";
const SECRET = "test-ingest-secret";

function post(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${INGEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Ingest-Secret": SECRET },
    body: JSON.stringify(body),
  });
}

function pending(secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["X-Ingest-Secret"] = secret;
  return SELF.fetch(`${BASE}${PRESS_PENDING_PATH}`, { headers });
}

async function seedPress(source: string, ext: string, n: number): Promise<number> {
  const res = await insertItem(
    env.DB,
    {
      source,
      externalId: `${source}-${n}`,
      category: "regulatory",
      eventAt: null,
      sourceUrl: `https://www.sec.gov/files/litigation/admin/2026/ia-${n}${ext}`,
      payload: { title: "In the Matter of Acme", authority: "SEC" },
      score: SCORE_POSTABLE,
      status: "logged",
    },
    new Date(),
  );
  return res.id!;
}

describe("press PDF bodies: the pending list", () => {
  it("requires the same secret as every other relay endpoint", async () => {
    expect((await pending(null)).status).toBe(401);
    expect((await pending("wrong")).status).toBe(401);
    expect((await pending("test-ingest-secreT")).status).toBe(401);
  });

  it("offers only PDF-linked press items that still have no body", async () => {
    const wantPdf = await seedPress("press_sec_enforcement", ".pdf", 1);
    await seedPress("press_sec_enforcement", ".htm", 2); // HTML: the generation fallback reads it
    await seedPress("press_ftc_competition", ".pdf", 3); // ships a usable RSS description already
    const done = await seedPress("press_boj", ".pdf", 4);
    await env.DB.prepare(`UPDATE items SET raw_text = 'already grounded' WHERE id = ?1`).bind(done).run();

    const body = (await (await pending()).json()) as { docs: { id: number; url: string }[] };
    expect(body.docs.map((d) => d.id)).toEqual([wantPdf]);
    expect(body.docs[0]!.url).toMatch(/\.pdf$/);
  });
});

describe("press PDF bodies: storing what the courier extracted", () => {
  it("stores the text and marks its provenance", async () => {
    const id = await seedPress("press_boj", ".pdf", 10);
    const res = await post({
      source: PRESS_BODY_SOURCE,
      body: JSON.stringify({ docs: [{ id, text: "The Bank decided to maintain the guideline for money market operations." }] }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(`SELECT raw_text AS t, raw_meta AS m FROM items WHERE id = ?1`)
      .bind(id)
      .first<{ t: string; m: string }>();
    expect(row!.t).toContain("money market operations");
    const meta = JSON.parse(row!.m) as Record<string, unknown>;
    expect(meta.mode).toBe("full");
    // The marker the generation fallback cannot forge: it never ran a PDF
    // extractor, so it cannot claim to have read one.
    expect(meta.document).toBe("courier-pdf");
  });

  it("scrubs URLs, since the prompt is URL-free by contract", async () => {
    const id = await seedPress("press_sec_enforcement", ".pdf", 11);
    await post({
      source: PRESS_BODY_SOURCE,
      body: JSON.stringify({ docs: [{ id, text: "Order available at www.sec.gov/litigation and https://x.test/y." }] }),
    });
    const t = (await env.DB.prepare(`SELECT raw_text AS t FROM items WHERE id = ?1`).bind(id).first<{ t: string }>())!.t;
    expect(t).not.toContain("www.sec.gov");
    expect(t).not.toContain("x.test");
    expect(t).toContain("Order available at");
  });

  it("stores nothing for a scan that yielded no text", async () => {
    // An empty extraction is not a document we read and found blank. Leaving
    // raw_text NULL keeps the item on the pending list for a later attempt.
    const id = await seedPress("press_boj", ".pdf", 12);
    await post({ source: PRESS_BODY_SOURCE, body: JSON.stringify({ docs: [{ id, text: "   " }] }) });
    const row = await env.DB.prepare(`SELECT raw_text AS t FROM items WHERE id = ?1`).bind(id).first<{ t: string | null }>();
    expect(row!.t).toBeNull();
  });

  it("never overwrites grounding text that is already there", async () => {
    // An RSS description captured at ingest is the item's own publisher
    // speaking. A later courier pass must not replace it.
    const id = await seedPress("press_boj", ".pdf", 13);
    await env.DB.prepare(`UPDATE items SET raw_text = 'from the feed' WHERE id = ?1`).bind(id).run();
    await post({ source: PRESS_BODY_SOURCE, body: JSON.stringify({ docs: [{ id, text: "from the pdf" }] }) });
    const t = (await env.DB.prepare(`SELECT raw_text AS t FROM items WHERE id = ?1`).bind(id).first<{ t: string }>())!.t;
    expect(t).toBe("from the feed");
  });

  it("rejects a malformed bundle loudly rather than accepting nothing", async () => {
    expect((await post({ source: PRESS_BODY_SOURCE, body: JSON.stringify({}) })).status).toBe(422);
    expect((await post({ source: PRESS_BODY_SOURCE, body: JSON.stringify({ docs: [{ id: "x" }] }) })).status).toBe(422);
    expect((await post({ source: PRESS_BODY_SOURCE, body: "not json" })).status).toBe(422);
  });
});
