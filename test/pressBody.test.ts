import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INGEST_PATH, PRESS_BODY_SOURCE, PRESS_PENDING_PATH } from "../src/ingestRelay";
import { insertItem, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import PRESS_SRC from "../src/ingesters/regulatoryPress.ts?raw";
import RELAY_SRC from "../src/ingestRelay.ts?raw";

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

describe("rawText carries an explicit provenance claim", () => {
  // WHY THIS IS NOT COSMETIC. checkGroundingProvenance short-circuits its
  // anchor check for same-entry text: a document parsed out of the very entry
  // that built the payload cannot be the wrong document. True for a feed
  // <description>. False for anything fetched separately.
  //
  // insertItem used to INFER the mode -- any caller passing rawText got
  // "ingest_rss" stamped for it. Both callers happened to be press paths, so
  // nothing was wrong. But a future ingester passing a FETCHED body as
  // rawText would have silently inherited the same-entry exemption and had a
  // mis-fetched document licensed for it, with no diff to catch it in: the
  // label described the population, not the mechanism.
  it("stamps same_entry as ingest_rss and a fetched body as full", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const base = {
      category: "regulatory",
      eventAt: now.toISOString(),
      sourceUrl: "https://example.gov/x",
      payload: { authority: "Example", title: "T" },
      score: SCORE_LOG_ONLY,
      status: "logged" as const,
    };
    await insertItem(
      env.DB,
      { ...base, source: "press_x", externalId: "same-1", rawText: "body", rawTextMode: "same_entry" },
      now,
    );
    await insertItem(
      env.DB,
      { ...base, source: "press_x", externalId: "fetch-1", rawText: "body", rawTextMode: "fetched" },
      now,
    );

    const rows = await env.DB.prepare(
      `SELECT external_id AS id, json_extract(raw_meta,'$.mode') AS mode
         FROM items WHERE source='press_x' ORDER BY external_id`,
    ).all<{ id: string; mode: string }>();
    const byId = Object.fromEntries(rows.results.map((r) => [r.id, r.mode]));
    expect(byId["fetch-1"]).toBe("full");
    expect(byId["same-1"]).toBe("ingest_rss");
  });

  it("every ingester that supplies rawText declares how it got it", () => {
    // A grep test, deliberately. The property is about CALL SITES, and no
    // runtime assertion can see a call site that does not exist yet. This one
    // fails the moment someone adds a third rawText writer without saying
    // which kind it is.
    // ?raw, not readFileSync: the workers pool has no filesystem.
    const files: Array<[string, string]> = [
      ["regulatoryPress.ts", PRESS_SRC],
      ["ingestRelay.ts", RELAY_SRC],
    ];
    for (const [f, src] of files) {
      const writes = (src.match(/rawText:/g) ?? []).length;
      const claims = (src.match(/rawTextMode:/g) ?? []).length;
      expect(claims, `${f}: ${writes} rawText writes but ${claims} provenance claims`).toBe(writes);
    }
  });
});
