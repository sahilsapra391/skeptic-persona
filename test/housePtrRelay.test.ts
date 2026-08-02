import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import MULTI from "./fixtures/house-ptr-multi.text.fixture?raw";
import SINGLE from "./fixtures/house-ptr-single.text.fixture?raw";
import { INGEST_PATH, PENDING_PATH } from "../src/ingestRelay";
import { HOUSE_RAW_TEXT_CAP, pollHousePtr, SOURCE as HOUSE_SOURCE } from "../src/ingesters/housePtr";
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

/** Seed a discovery-level House item exactly as pollHousePtr would:
 *  eventAt derives from filedDate (houseDateToIso does the same). */
async function seedIndexRow(
  docId: string,
  now: Date,
  over: Partial<{ efiled: boolean; filedDate: string; member: string }> = {},
) {
  const filedDate = over.filedDate ?? "07/27/2026";
  const [m, d, y] = filedDate.split("/").map(Number);
  await insertItem(
    env.DB,
    {
      source: HOUSE_SOURCE,
      externalId: docId,
      category: "congress",
      eventAt: new Date(Date.UTC(y!, m! - 1, d!)).toISOString(),
      sourceUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`,
      payload: {
        member: over.member ?? "Hon. Example Member",
        stateDst: "CA01",
        filedDate,
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

// The /ingest endpoint is exercised through SELF.fetch, where the Worker
// evaluates freshness on ITS OWN clock — a test cannot inject `now` through
// an HTTP boundary. Tests that assert queue-vs-lake outcomes must therefore
// seed filing dates relative to the real clock; everything date-insensitive
// keeps the pinned NOW. (These two tests went red four days after they were
// written because the pinned date quietly aged past the 48h freshness window.)
const REAL_NOW = new Date();
const FRESH_FILED = `${String(REAL_NOW.getUTCMonth() + 1).padStart(2, "0")}/${String(
  REAL_NOW.getUTCDate(),
).padStart(2, "0")}/${REAL_NOW.getUTCFullYear()}`;

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
    await seedIndexRow("20260100", REAL_NOW, { filedDate: FRESH_FILED });
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

  it("applies the docs before a malformed one, so 422 does not mean nothing landed", async () => {
    // The relay is NOT atomic, and this is the test that says so. A bundle
    // whose third doc is malformed returns 422, but the first doc has already
    // been applied and committed by then -- the throw happens mid-loop, not
    // before it.
    //
    // That is survivable only because of the two properties asserted below:
    // the un-applied doc is still listed by /pending, so the courier's next
    // run picks it up, and re-applying is idempotent. If either ever stops
    // being true, a partial bundle silently drops filings and the only
    // symptom is a 422 the courier already expects to retry.
    //
    // This behaviour was investigated on 2026-07-28 in a scratch file that
    // logged it and asserted nothing (test/zzRefuteScratch.test.ts, on main
    // until 2026-08-01). Two tests, zero expects, counted green the whole
    // time. The findings were right; they just were not pinned.
    await seedIndexRow("30000200", NOW);
    await seedIndexRow("30000201", NOW);

    const res = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({
        docs: [
          { docId: "30000200", text: SINGLE },
          { docId: 12345, text: SINGLE }, // number, not string -> throws
          { docId: "30000201", text: SINGLE },
        ],
      }),
    });
    expect(res.status).toBe(422);

    // Applied despite the 422: it was processed before the bad doc.
    expect((await payloadOf("30000200")).transactions).not.toBeNull();
    // Never reached.
    expect((await payloadOf("30000201")).transactions).toBeNull();

    // The recovery path: /pending still offers ONLY the un-applied one.
    const offered = (await (await pending()).json()) as { docs: { docId: string }[] };
    expect(offered.docs.map((d) => d.docId)).toContain("30000201");
    expect(offered.docs.map((d) => d.docId)).not.toContain("30000200");

    // The courier's next run drains it with a well-formed bundle.
    const res2 = await post({
      source: HOUSE_SOURCE,
      body: JSON.stringify({ docs: [{ docId: "30000201", text: SINGLE }] }),
    });
    expect(res2.status).toBe(200);
    expect((await payloadOf("30000201")).transactions).not.toBeNull();

    const after = (await (await pending()).json()) as { docs: { docId: string }[] };
    expect(after.docs.map((d) => d.docId)).not.toContain("30000201");
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
    for (const d of docs) await seedIndexRow(d, REAL_NOW, { filedDate: FRESH_FILED });

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

    await pollHousePtr(env as never, REAL_NOW);

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

describe("the filing's own text is kept as grounding", () => {
  async function rawOf(docId: string) {
    return env.DB.prepare(`SELECT raw_text AS t, raw_meta AS m FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:${docId}`)
      .first<{ t: string | null; m: string | null }>();
  }

  it("stores the extracted body, which cost no extra fetch", async () => {
    // The courier already extracted this to parse transactions out of it, and
    // it was discarded the moment parsing finished. CONGRESS_PTR is both the
    // signature archetype and the deepest-exemplared one, so this is the
    // highest-value grounding text in the pipeline and it is free.
    await seedIndexRow("20260400", NOW);
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260400", text: MULTI }] }) });

    const row = await rawOf("20260400");
    expect(row?.t).toBeTruthy();
    expect(row!.t).toContain("Home Depot");
    const meta = JSON.parse(row!.m!) as Record<string, unknown>;
    expect(meta.mode).toBe("full");
    expect(meta.host).toBe("disclosures-clerk.house.gov");
    expect(meta.document).toBe("20260400.pdf");
  });

  it("scrubs the asset-type URL every House PTR carries", async () => {
    // 100% of filings: all seven fixtures contain
    // https://fd.house.gov/reference/asset-type-codes.aspx beneath the
    // transaction table. Without scrubbing, raw_text puts a URL inside the
    // SOURCE DOCUMENT block of a prompt that forbids URLs, and every variant
    // echoing it is rejected -- burning both retries on the archetype with
    // the deepest exemplar bank. The omission was untested in BOTH
    // directions, which is why it survived.
    expect(MULTI).toContain("https://fd.house.gov");
    await seedIndexRow("20260500", NOW);
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260500", text: MULTI }] }) });

    const row = await env.DB.prepare(`SELECT raw_text AS t FROM items WHERE dedup_key = ?1`)
      .bind(`${HOUSE_SOURCE}:20260500`)
      .first<{ t: string }>();
    expect(row!.t).not.toContain("fd.house.gov");
    expect(row!.t).not.toMatch(/https?:\/\//);
    // The filing itself must survive the scrub.
    expect(row!.t).toContain("Home Depot");
  });

  it("strips the NUL bytes the font encoding injects", async () => {
    // House PDFs carry NULs from a font quirk. A NUL reaching a generation
    // prompt is invisible junk at best; at worst it is the byte that makes a
    // downstream binary check fire on legitimate text.
    await seedIndexRow("20260401", NOW);
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260401", text: SINGLE }] }) });

    const row = await rawOf("20260401");
    expect(SINGLE).toContain("\u0000");
    expect(row!.t).not.toContain("\u0000");
    expect(row!.t).toContain("Ares Capital");
  });

  it("stores nothing when the extraction is refused", async () => {
    // A filing held by the completeness gate must not leave grounding text
    // behind: the body would license facts for a trade list we declined to
    // publish precisely because we could not read all of it.
    await seedIndexRow("20260402", NOW);
    const truncated = MULTI.slice(0, MULTI.lastIndexOf("$")) + "$";
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260402", text: truncated }] }) });

    const row = await rawOf("20260402");
    expect(row?.t).toBeNull();
    expect(row?.m).toBeNull();
  });

  it("caps a long body at the same ceiling the generation path uses", async () => {
    await seedIndexRow("20260403", NOW);
    const padded = MULTI + " lorem ipsum".repeat(4_000);
    await post({ source: HOUSE_SOURCE, body: JSON.stringify({ docs: [{ docId: "20260403", text: padded }] }) });

    const row = await rawOf("20260403");
    expect(row!.t!.length).toBe(HOUSE_RAW_TEXT_CAP);
    expect(JSON.parse(row!.m!).truncated).toBe(true);
  });
});
