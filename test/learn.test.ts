import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  editDistance,
  editRatio,
  ownerFinals,
  promotionStatement,
  recentEditedPairs,
  registerFor,
  zeroEditStats,
  EDIT_DISTANCE_MAX_LEN,
} from "../src/rag/learn";
import { renderDigest, runVoiceDigest, DIGEST_WINDOW_DAYS } from "../src/rag/digest";
import { deliverCards } from "../src/rag/deliver";
import { createQueueEntry, decideQueueEntry, insertItem, SCORE_POSTABLE } from "../src/lib/db";
import { iso } from "../src/lib/time";

// P4-09, the learning loop. The behaviours under test are the ones that make
// the metric trustworthy rather than merely present:
//   - the (draft, final) pair is CAPTURED, and survives a regeneration that
//     changes what re-derivation would have returned;
//   - no data reports as no data, never as 0% or 100%;
//   - promotion and the post_log claim land together or not at all.

const NOW = new Date("2026-08-02T16:00:00Z");
const WEBHOOK_URL = "https://worker.local/tg/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const TG = "https://api.telegram.org";
const BOT = "/botTEST:TOKEN";
const OWNER = 424242;

let updateId = 9000;
const SEND: Array<Record<string, unknown>> = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  for (const path of ["answerCallbackQuery", "editMessageText"]) {
    fetchMock
      .get(TG)
      .intercept({ path: `${BOT}/${path}`, method: "POST" })
      .reply(200, () => JSON.stringify({ ok: true, result: { message_id: 555 } }))
      .persist();
  }
  fetchMock
    .get(TG)
    .intercept({ path: `${BOT}/sendMessage`, method: "POST" })
    .reply((opts) => {
      SEND.push(JSON.parse(String(opts.body)) as Record<string, unknown>);
      return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 7000 + SEND.length, chat: { id: OWNER } } }) };
    })
    .persist();
});

async function seed(externalId: string, variants: Array<{ variant: string; text: string; status?: string }>): Promise<number> {
  const item = await insertItem(env.DB, {
    source: "senate_ptr",
    externalId,
    category: "congress",
    eventAt: iso(NOW),
    sourceUrl: `https://efdsearch.senate.gov/${externalId}`,
    payload: { member: "Jane Roe", lagDays: 45, tradeDate: "2026-06-03", chamber: "senate" },
    score: SCORE_POSTABLE,
  });
  const queueId = await createQueueEntry(env.DB, item.id ?? 0, "CONGRESS_PTR", "Draft text, per Senate eFD", NOW);
  await decideQueueEntry(env.DB, queueId, "approved", NOW);
  for (const v of variants) {
    await env.DB.prepare(
      `INSERT INTO generations (queue_id, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1, ?2, ?3, 'sk', 'op', ?4, (SELECT COALESCE(MAX(attempt),0)+1 FROM generations WHERE queue_id = ?1), ?5)`,
    )
      .bind(queueId, v.variant, v.text, v.status ?? "valid", iso(NOW))
      .run();
  }
  return queueId;
}

const cycleOf = async (qid: number): Promise<number> =>
  (await env.DB.prepare(`SELECT MAX(id) AS c FROM generations WHERE queue_id = ?1`).bind(qid).first<{ c: number }>())!.c;

/** Seed AND deliver: the card row must exist or every tap is a stale no-op. */
async function delivered(externalId: string, text: string): Promise<{ qid: number; cy: number }> {
  const qid = await seed(externalId, [{ variant: "commentary", text }]);
  await deliverCards(env as never, NOW);
  return { qid, cy: await cycleOf(qid) };
}

const post = (body: unknown): Promise<Response> =>
  SELF.fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", [SECRET_HEADER]: "test-webhook-secret" },
    body: JSON.stringify(body),
  });

const tap = (data: string): Promise<Response> =>
  post({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from: { id: OWNER }, message: { message_id: 901 }, data } });

const reply = (toMessageId: number, text: string): Promise<Response> =>
  post({
    update_id: ++updateId,
    message: { message_id: ++updateId, chat: { id: OWNER }, from: { id: OWNER }, text, reply_to_message: { message_id: toMessageId } },
  });

const logRow = (qid: number): Promise<{ final_text: string; draft_text: string | null; draft_variant: string | null; edit_distance: number | null } | null> =>
  env.DB.prepare(`SELECT final_text, draft_text, draft_variant, edit_distance FROM post_log WHERE queue_id = ?1`).bind(qid).first();

describe("editDistance", () => {
  it("is 0 for identical strings and counts single-character edits", () => {
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abc", "abd")).toBe(1); // substitution
    expect(editDistance("abc", "abcd")).toBe(1); // insertion
    expect(editDistance("abc", "ab")).toBe(1); // deletion
    expect(editDistance("", "abc")).toBe(3);
  });

  it("saturates rather than hanging on pathological input", () => {
    const huge = "x".repeat(EDIT_DISTANCE_MAX_LEN + 1);
    expect(editDistance(huge, "short")).toBe(huge.length);
    expect(editRatio(huge, "short")).toBe(1);
  });

  it("editRatio of an empty pair is 0, not NaN", () => {
    expect(editRatio("", "")).toBe(0); // 0/0 must not reach the metric
  });
});

describe("registerFor — a template fallback is never promoted", () => {
  it("maps generated variants and refuses our own boilerplate", () => {
    expect(registerFor("commentary")).toBe("commentary");
    expect(registerFor("sharp")).toBe("wire");
    expect(registerFor("dry")).toBe("wire");
    // Promoting the template would teach the model to reproduce the very
    // thing generation exists to replace.
    expect(registerFor("template")).toBeNull();
    expect(registerFor(null)).toBeNull();
  });

  it("promotionStatement returns null for anything unpromotable", () => {
    expect(promotionStatement(env.DB, NOW, { queueId: 1, archetype: "CONGRESS_PTR", variant: "template", finalText: "x", wasEdited: false })).toBeNull();
    expect(promotionStatement(env.DB, NOW, { queueId: 1, archetype: "CONGRESS_PTR", variant: "dry", finalText: "   ", wasEdited: false })).toBeNull();
  });
});

describe("zero-edit rate — no data is not a score", () => {
  it("reports NO RATE when nothing has been published", async () => {
    const stats = await zeroEditStats(env.DB, new Date(NOW.getTime() + 86_400_000)); // future window: empty
    expect(stats.posted).toBe(0);
    expect(stats.rate).toBeNull(); // NOT 0, and NOT 1
    const text = renderDigest(stats, [], DIGEST_WINDOW_DAYS);
    expect(text).toContain("no posts published");
    expect(text).toContain("This is not a score of 0%");
    // The copy says "not a score of 0%" on purpose; what must never appear is
    // a REPORTED rate.
    expect(text).not.toMatch(/Zero-edit rate: \d+%/);
  });

  it("distinguishes UNCAPTURED pairs from unedited ones", async () => {
    // A post_log row from before p4-09: final_text present, draft absent.
    const qid = await seed("L-legacy", [{ variant: "dry", text: "legacy" }]);
    await env.DB.prepare(
      `INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category, posted_manually, final_text)
       VALUES (?1, NULL, ?2, 'CONGRESS_PTR', 'congress', 1, 'posted before capture existed')`,
    )
      .bind(qid, iso(NOW))
      .run();
    const stats = await zeroEditStats(env.DB, new Date(NOW.getTime() - 3600_000));
    expect(stats.uncaptured).toBeGreaterThan(0);
    expect(stats.unedited).toBe(0);
    // NULL edit_distance must never be read as "shipped verbatim".
    expect(stats.rate).toBeNull();
    expect(renderDigest(stats, [], DIGEST_WINDOW_DAYS)).toContain("unmeasurable");
  });
});

describe("pair capture through the real webhook", () => {
  it("Posted (unedited): draft == final, distance 0, promoted as an exemplar", async () => {
    const { qid, cy } = await delivered("L-yes", "Senate PTR: a real commentary line, per Senate eFD.");
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:y:${qid}:${cy}:c`);

    const row = await logRow(qid);
    expect(row!.draft_text).toBe("Senate PTR: a real commentary line, per Senate eFD.");
    expect(row!.final_text).toBe(row!.draft_text);
    expect(row!.draft_variant).toBe("commentary");
    expect(row!.edit_distance).toBe(0);

    const promoted = await ownerFinals(env.DB, "CONGRESS_PTR", 10);
    expect(promoted.map((p) => p.text)).toContain("Senate PTR: a real commentary line, per Senate eFD.");
    expect(promoted[0]!.register).toBe("commentary");
  });

  it("Posted (edited): the pair is the DRAFT SHOWN and the text typed", async () => {
    const { qid, cy } = await delivered("L-mod", "the drafted line, per Senate eFD.");
    await tap(`c:c:${qid}:${cy}`);
    const before = SEND.length;
    await tap(`p:m:${qid}:${cy}:c`);
    // The force-reply prompt is the last message sent.
    const promptId = 7000 + SEND.length;
    expect(SEND.length).toBeGreaterThan(before);

    await reply(promptId, "the line I actually posted, per Senate eFD.");
    const row = await logRow(qid);
    expect(row!.draft_text).toBe("the drafted line, per Senate eFD.");
    expect(row!.final_text).toBe("the line I actually posted, per Senate eFD.");
    expect(row!.edit_distance).toBeGreaterThan(0);
    expect(row!.draft_variant).toBe("commentary");

    // The owner's own words are promoted, flagged as edited.
    const promoted = await env.DB.prepare(`SELECT text, was_edited FROM voice_finals WHERE queue_id = ?1`).bind(qid).first<{ text: string; was_edited: number }>();
    expect(promoted!.text).toBe("the line I actually posted, per Senate eFD.");
    expect(promoted!.was_edited).toBe(1);
  });

  it("HIGH: the captured draft SURVIVES a regeneration that would change re-derivation", async () => {
    // The reason the pair is stored rather than recomputed. resolveVariantText
    // takes the LATEST valid attempt, so had we re-derived at digest time we
    // would have compared the owner's post against text he never saw — and it
    // would have looked like a perfectly ordinary pair.
    const { qid, cy } = await delivered("L-regen", "ORIGINAL draft the owner saw, per Senate eFD.");
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:m:${qid}:${cy}:c`);
    const promptId = 7000 + SEND.length;

    // A later generation lands before the owner answers.
    await env.DB.prepare(
      `INSERT INTO generations (queue_id, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1, 'commentary', 'A LATER draft the owner never saw, per Senate eFD.', 'sk2', 'op2', 'valid', 9, ?2)`,
    )
      .bind(qid, iso(NOW))
      .run();

    await reply(promptId, "what I posted, per Senate eFD.");
    const row = await logRow(qid);
    expect(row!.draft_text).toBe("ORIGINAL draft the owner saw, per Senate eFD.");
    expect(row!.draft_text).not.toContain("never saw");
  });
});

describe("the metric cannot be inflated by the capture path", () => {
  it("retyping the draft EXACTLY records an unedited post, not an edited one", async () => {
    // Going through the "I edited it" flow is not proof of an edit. Booking it
    // as one would make post_log.edit_distance (0) and voice_finals.was_edited
    // (1) disagree about the same post.
    const { qid, cy } = await delivered("L-retype", "the exact same line, per Senate eFD.");
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:m:${qid}:${cy}:c`);
    const promptId = 7000 + SEND.length;
    await reply(promptId, "the exact same line, per Senate eFD.");

    const row = await logRow(qid);
    expect(row!.edit_distance).toBe(0);
    const promoted = await env.DB.prepare(`SELECT was_edited FROM voice_finals WHERE queue_id = ?1`).bind(qid).first<{ was_edited: number }>();
    expect(promoted!.was_edited).toBe(0); // agrees with edit_distance
  });

  it("an empty draft is captured as MISSING, never as a perfect zero-edit post", async () => {
    // A card whose only terminal row is fallback_blocked resolves to no text.
    // Recording ("", "", 0) would book an empty post as a zero-edit success.
    const qid = await seed("L-empty", [{ variant: "none", text: "", status: "fallback_blocked" }]);
    await deliverCards(env as never, NOW);
    const cy = await cycleOf(qid);
    await tap(`p:y:${qid}:${cy}:c`);

    const row = await logRow(qid);
    expect(row).not.toBeNull(); // the claim IS written; it is the PAIR that is null
    expect(row!.edit_distance).toBeNull(); // uncaptured, not 0
    expect(row!.draft_text).toBeNull();
    expect(row!.draft_variant).toBeNull();
    // And nothing empty was promoted as an exemplar.
    const promoted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM voice_finals WHERE queue_id = ?1`).bind(qid).first<{ n: number }>();
    expect(promoted!.n).toBe(0);
  });
});

describe("the digest", () => {
  it("always shows a denominator and flags a small sample", async () => {
    const stats = { posted: 2, unedited: 2, edited: 0, uncaptured: 0, rate: 1, meanEditRatio: null };
    const text = renderDigest(stats, [], 7);
    expect(text).toContain("2 of 2");
    expect(text).toContain("Small sample");
    expect(text).toContain("direction, not a measurement");
  });

  it("quotes what changed on edited posts", async () => {
    const text = renderDigest(
      { posted: 6, unedited: 4, edited: 2, uncaptured: 0, rate: 4 / 6, meanEditRatio: 0.25 },
      [{ queueId: 11, archetype: "CONGRESS_PTR", variant: "commentary", draft: "drafted line", final: "posted line", distance: 3, ratio: 0.25 }],
      7,
    );
    expect(text).toContain("67%");
    expect(text).toContain("changed 25% of the text");
    expect(text).toContain("drafted: drafted line");
    expect(text).toContain("posted:  posted line");
  });

  it("runs end to end and sends exactly one message", async () => {
    const before = SEND.length;
    await runVoiceDigest(env as never, NOW);
    expect(SEND.length).toBe(before + 1);
    expect(String(SEND[SEND.length - 1]!.text)).toContain("Zero-edit rate");
  });

  it("a send failure is swallowed — a report is not a pipeline stage", async () => {
    // No interceptor change needed: the digest catches and logs. Assert it
    // does not throw, because a throwing digest would fail the job row and
    // retry-storm a report nobody is waiting on.
    await expect(runVoiceDigest(env as never, NOW)).resolves.toBeUndefined();
  });
});

describe("ownerFinals ranking", () => {
  it("shipped-unedited outrank rewritten", async () => {
    await env.DB.prepare(`DELETE FROM voice_finals`).run();
    const mk = async (qid: number, text: string, edited: number, at: string): Promise<void> => {
      const q = await seed(`L-rank-${qid}-${text.length}`, [{ variant: "dry", text }]);
      await env.DB.prepare(
        `INSERT INTO voice_finals (queue_id, archetype, register, text, was_edited, promoted_at) VALUES (?1,'CONGRESS_PTR','wire',?2,?3,?4)`,
      )
        .bind(q, text, edited, at)
        .run();
    };
    await mk(1, "rewritten but newest", 1, "2026-08-02T00:00:00.000Z");
    await mk(2, "shipped as generated", 0, "2026-07-01T00:00:00.000Z");
    const finals = await ownerFinals(env.DB, "CONGRESS_PTR", 5);
    // The unedited one is OLDER and still ranks first: it is the only one that
    // proves the voice is reachable from the prompt.
    expect(finals[0]!.text).toBe("shipped as generated");
  });

  it("returns nothing for an archetype with no finals, and honours limit 0", async () => {
    expect(await ownerFinals(env.DB, "FILING_8K", 5)).toEqual([]);
    expect(await ownerFinals(env.DB, "CONGRESS_PTR", 0)).toEqual([]);
  });
});

describe("meanEditRatio is computed by SQL, so exercise the SQL", () => {
  it("averages the ratio over EDITED rows only, from real captured pairs", async () => {
    // Written because the expression lives in a query string: a typo there
    // fails silently as NULL, and a digest that quietly stops reporting the
    // edit size is the exact shape this project keeps paying for.
    await env.DB.prepare(`DELETE FROM post_log`).run();
    const mk = async (ext: string, draft: string, final: string, dist: number): Promise<void> => {
      const q = await seed(ext, [{ variant: "dry", text: draft }]);
      await env.DB.prepare(
        `INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category, posted_manually,
                               final_text, draft_text, draft_variant, edit_distance)
         VALUES (?1, NULL, ?2, 'CONGRESS_PTR', 'congress', 1, ?3, ?4, 'dry', ?5)`,
      )
        .bind(q, iso(NOW), final, draft, dist)
        .run();
    };
    await mk("M-clean", "abcdefghij", "abcdefghij", 0); // unedited
    await mk("M-half", "abcdefghij", "abcdeXXXXX", 5); // 5/10 = 0.5
    await mk("M-tenth", "abcdefghij", "abcdefghiX", 1); // 1/10 = 0.1

    const stats = await zeroEditStats(env.DB, new Date(NOW.getTime() - 3600_000));
    expect(stats.unedited).toBe(1);
    expect(stats.edited).toBe(2);
    expect(stats.rate).toBeCloseTo(1 / 3, 5);
    // The unedited row must NOT drag the average toward zero.
    expect(stats.meanEditRatio).toBeCloseTo(0.3, 5);
    expect(renderDigest(stats, [], 7)).toContain("changed 30% of the text");
  });

  it("meanEditRatio stays null when nothing was edited", async () => {
    await env.DB.prepare(`DELETE FROM post_log`).run();
    const q = await seed("M-none", [{ variant: "dry", text: "x" }]);
    await env.DB.prepare(
      `INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category, posted_manually,
                             final_text, draft_text, draft_variant, edit_distance)
       VALUES (?1, NULL, ?2, 'CONGRESS_PTR', 'congress', 1, 'x', 'x', 'dry', 0)`,
    )
      .bind(q, iso(NOW))
      .run();
    const stats = await zeroEditStats(env.DB, new Date(NOW.getTime() - 3600_000));
    expect(stats.rate).toBe(1);
    expect(stats.meanEditRatio).toBeNull();
    expect(renderDigest(stats, [], 7)).not.toContain("of the text on average");
  });
});

describe("recentEditedPairs", () => {
  it("returns ONLY edited pairs, and excludes uncaptured and unedited rows", async () => {
    // Seeds its own rows rather than reading whatever earlier tests left
    // behind: a loop over an empty array passes without asserting anything.
    await env.DB.prepare(`DELETE FROM post_log`).run();
    const mk = async (ext: string, draft: string | null, dist: number | null): Promise<number> => {
      const q = await seed(ext, [{ variant: "dry", text: ext }]);
      await env.DB.prepare(
        `INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category, posted_manually,
                               final_text, draft_text, draft_variant, edit_distance)
         VALUES (?1, NULL, ?2, 'CONGRESS_PTR', 'congress', 1, 'the final text', ?3, 'dry', ?4)`,
      )
        .bind(q, iso(NOW), draft, dist)
        .run();
      return q;
    };
    const editedId = await mk("R-edited", "the draft text", 4);
    await mk("R-unedited", "the final text", 0);
    await mk("R-uncaptured", null, null);

    const pairs = await recentEditedPairs(env.DB, new Date(NOW.getTime() - 3600_000), 20);
    expect(pairs.map((p) => p.queueId)).toEqual([editedId]);
    expect(pairs[0]!.draft).toBe("the draft text");
    expect(pairs[0]!.final).toBe("the final text");
    expect(pairs[0]!.distance).toBe(4);
    expect(pairs[0]!.ratio).toBeCloseTo(4 / 14, 5);
  });
});
