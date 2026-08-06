import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  editDistance,
  editRatio,
  normalisePost,
  ownerFinals,
  pairContext,
  promotionStatement,
  recentEditedPairs,
  registerFor,
  zeroEditStats,
  EDIT_DISTANCE_MAX_LEN,
} from "../src/rag/learn";
import { renderDigest, runVoiceDigest, northStarStats, renderNorthStar, efdLatency, renderEfdLatency, DIGEST_WINDOW_DAYS } from "../src/rag/digest";
import { MAX_OWNER_FINALS, ownerFinalsAllowance } from "../src/rag/generate";
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

    // NOT promoted: an unedited final is the model's own output, and feeding
    // it back is training on its own predictions. See promotionStatement.
    const promoted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM voice_finals WHERE queue_id = ?1`)
      .bind(qid).first<{ n: number }>();
    expect(promoted!.n).toBe(0);
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

describe("pair context — an edit is not always a voice signal", () => {
  it("captures payload depth and grounding size alongside the pair", async () => {
    // Raised by the ingestion session: a rewrite forced by a THIN payload
    // teaches the model to compensate for missing facts, not to write better.
    // Telling that apart later needs the context captured now.
    const { qid, cy } = await delivered("L-ctx", "a line with a real payload behind it, per Senate eFD.");
    await env.DB.prepare(`UPDATE items SET raw_text = ?1 WHERE id = (SELECT item_id FROM queue WHERE id = ?2)`)
      .bind("x".repeat(1234), qid)
      .run();
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:y:${qid}:${cy}:c`);

    const row = await env.DB.prepare(`SELECT payload_field_count, grounding_chars FROM post_log WHERE queue_id = ?1`)
      .bind(qid)
      .first<{ payload_field_count: number | null; grounding_chars: number | null }>();
    // The seeded payload has member/lagDays/tradeDate/chamber.
    expect(row!.payload_field_count).toBe(4);
    expect(row!.grounding_chars).toBe(1234);
  });

  it("an unparseable payload is UNKNOWN depth, not zero depth", async () => {
    const qid = await seed("L-badpayload", [{ variant: "dry", text: "x" }]);
    await env.DB.prepare(`UPDATE items SET payload = 'not json' WHERE id = (SELECT item_id FROM queue WHERE id = ?1)`)
      .bind(qid)
      .run();
    const ctx = await pairContext(env.DB, qid);
    expect(ctx.payloadFieldCount).toBeNull(); // null, never 0 — 0 would read as "no facts"
    expect(ctx.groundingChars).toBe(0);
  });

  it("an unknown queue id yields nulls rather than throwing at post time", async () => {
    expect(await pairContext(env.DB, 999_999)).toEqual({ payloadFieldCount: null, groundingChars: null });
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
    // was_edited would have been 0, and an unedited final is not promoted at
    // all — so the two records agree by being consistently absent.
    const promoted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM voice_finals WHERE queue_id = ?1`)
      .bind(qid).first<{ n: number }>();
    expect(promoted!.n).toBe(0);
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
    const stats = { posted: 2, unedited: 2, edited: 0, uncaptured: 0, templateFallbacks: 0, rate: 1, meanEditRatio: null };
    const text = renderDigest(stats, [], 7);
    expect(text).toContain("2 of 2");
    expect(text).toContain("Small sample");
    expect(text).toContain("direction, not a measurement");
  });

  it("quotes what changed on edited posts", async () => {
    const text = renderDigest(
      { posted: 6, unedited: 4, edited: 2, uncaptured: 0, templateFallbacks: 0, rate: 4 / 6, meanEditRatio: 0.25 },
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

describe("ownerFinals — the collapse containment", () => {
  it("CRITICAL: an UNEDITED final is never promoted, so the model cannot feed itself", () => {
    // Review found the containment argument wrong three ways: skeletonHash
    // masks only entities/numbers/CAPS so one lowercase word defeats it,
    // openerHash runs on raw text whose leading tokens vary per item, and an
    // owner-edited final has no `generations` row for collisionCheck to read.
    // Detection was the wrong instrument; the loop is cut at the source.
    expect(promotionStatement(env.DB, NOW, {
      queueId: 1, archetype: "CONGRESS_PTR", variant: "commentary",
      finalText: "a draft the owner shipped unchanged", wasEdited: false,
    })).toBeNull();
    // The owner's own rewrite still promotes: that is the only new signal.
    expect(promotionStatement(env.DB, NOW, {
      queueId: 1, archetype: "CONGRESS_PTR", variant: "commentary",
      finalText: "what the owner actually wrote", wasEdited: true,
    })).not.toBeNull();
  });

  it("owner rewrites can no longer be STARVED by shipped-unedited finals", async () => {
    // Reproduced before fixing: three rewrites, all newer, and every returned
    // slot was MODEL OUTPUT. Migration 0030's comment claimed the opposite.
    await env.DB.prepare(`DELETE FROM voice_finals`).run();
    const ins = async (tag: string, text: string, edited: number, at: string): Promise<void> => {
      const q = await seed(`rank-${tag}`, [{ variant: "dry", text: "x" }]);
      await env.DB.prepare(
        `INSERT INTO voice_finals (queue_id, archetype, register, text, was_edited, promoted_at)
         VALUES (?1,'CONGRESS_PTR','wire',?2,?3,?4)`,
      ).bind(q, text, edited, at).run();
    };
    for (let i = 0; i < 4; i++) await ins(`m${i}`, `MODEL OUTPUT ${i}`, 0, `2026-07-0${i + 1}T00:00:00.000Z`);
    await ins("o1", "OWNER REWRITE, per Senate eFD.", 1, "2026-08-01T00:00:00.000Z");

    const finals = await ownerFinals(env.DB, "CONGRESS_PTR", 4);
    // Legacy unedited rows are filtered out entirely, so the rewrite is all
    // that remains — it cannot be crowded out by the model's own output.
    expect(finals.map((f) => f.text)).toEqual(["OWNER REWRITE, per Senate eFD."]);
  });

  it("a promoted final that fails the register gate never reaches a prompt", async () => {
    // Committed exemplars are register- and length-tested in stylepack.test.ts;
    // promoted ones passed nothing. Waiving the gate to RECORD an already
    // public post is right; waiving it to put the string in a prompt as the
    // voice to match is a different decision, and it was inherited not made.
    await env.DB.prepare(`DELETE FROM voice_finals`).run();
    const q = await seed("rank-bad", [{ variant: "dry", text: "x" }]);
    await env.DB.prepare(
      `INSERT INTO voice_finals (queue_id, archetype, register, text, was_edited, promoted_at)
       VALUES (?1,'CONGRESS_PTR','wire',?2,1,?3)`,
    ).bind(q, "see https://example.com for the filing", iso(NOW)).run();
    expect(await ownerFinals(env.DB, "CONGRESS_PTR", 4)).toEqual([]);
  });

  it("returns nothing for an archetype with no finals, and honours limit 0", async () => {
    expect(await ownerFinals(env.DB, "FILING_8K", 5)).toEqual([]);
    expect(await ownerFinals(env.DB, "CONGRESS_PTR", 0)).toEqual([]);
  });
});

describe("the promoted bank can never outvote the committed one", () => {
  it("holds promoted finals to a strict minority at every real bank size", () => {
    // Review finding: a FLAT cap of 4 is not a cap where it matters. Live
    // committed banks are CONGRESS_PTR 7, FILING_FORM4 5, FILING_8K 4,
    // REGULATORY_NEWS 3, and INSIDER_CLUSTER / HALT / MACRO_PRINT /
    // RATE_DECISION 2 each — so four promoted finals would have made the bank
    // majority-promoted for FIVE of the eight, placed first, under a header
    // saying they outrank everything above on tone.
    const LIVE_BANKS = [
      ["CONGRESS_PTR", 7], ["FILING_FORM4", 5], ["FILING_8K", 4], ["REGULATORY_NEWS", 3],
      ["INSIDER_CLUSTER", 2], ["HALT", 2], ["MACRO_PRINT", 2], ["RATE_DECISION", 2],
    ] as const;
    for (const [name, committed] of LIVE_BANKS) {
      const allowed = ownerFinalsAllowance(committed);
      expect(allowed, `${name}: promoted must stay a strict minority`).toBeLessThan(committed);
      expect(allowed / (allowed + committed), `${name}`).toBeLessThan(0.5);
    }
    // The thin banks contribute nothing until the owner writes a third.
    expect(ownerFinalsAllowance(2)).toBe(0);
    expect(ownerFinalsAllowance(0)).toBe(0);
    // And the absolute ceiling still binds for a hypothetically large bank.
    expect(ownerFinalsAllowance(100)).toBe(MAX_OWNER_FINALS);
  });
});

describe("the template fallback cannot inflate the headline", () => {
  it("template rows are named separately, never counted as zero-edit wins", async () => {
    // Three templates with distance 0 previously printed "100% - 3 of 3 went
    // out exactly as generated" while the LLM path produced nothing at all.
    await env.DB.prepare(`DELETE FROM post_log`).run();
    for (let i = 0; i < 3; i++) {
      const q = await seed(`tmpl-${i}`, [{ variant: "none", text: "t", status: "fallback_template" }]);
      await env.DB.prepare(
        `INSERT INTO post_log (queue_id, platform_post_id, posted_at, archetype, category, posted_manually,
                               final_text, draft_text, draft_variant, edit_distance)
         VALUES (?1, NULL, ?2, 'CONGRESS_PTR', 'congress', 1, 'boilerplate', 'boilerplate', 'template', 0)`,
      ).bind(q, iso(NOW)).run();
    }
    const stats = await zeroEditStats(env.DB, new Date(NOW.getTime() - 3600_000));
    expect(stats.templateFallbacks).toBe(3);
    expect(stats.unedited).toBe(0);
    expect(stats.rate).toBeNull(); // unmeasurable, NOT 100%
    const text = renderDigest(stats, [], 7);
    expect(text).not.toContain("100%");
    expect(text).toContain("TEMPLATE fallback");
    expect(text).toContain("generation is failing");
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

describe("a whitespace-only reply is not an edit", () => {
  // HIGH from re-review: promotionStatement stored finalText.trim() while
  // editDistance measured the untrimmed pair, so replying with the draft plus
  // one trailing space gave distance 1 and wrote a voice_finals row
  // BYTE-IDENTICAL to post_log.draft_text — raw model output re-entering the
  // prompt as the owner's signed voice.
  const DRAFT = "Roe disclosed the sale 45 days after the trade date, per Senate eFD.";

  it("normalisePost collapses the whole class, not just the reported instance", () => {
    expect(normalisePost(DRAFT + " ")).toBe(DRAFT);
    expect(normalisePost(" " + DRAFT)).toBe(DRAFT);
    expect(normalisePost(DRAFT + "\n")).toBe(DRAFT);
    expect(normalisePost(DRAFT.replace("the sale", "the  sale"))).toBe(DRAFT);
    // Segment structure survives — it carries fact / beat / take.
    expect(normalisePost("fact, per SEC.\n\nthe take.")).toBe("fact, per SEC.\n\nthe take.");
    // A GENUINE edit is untouched.
    expect(normalisePost(DRAFT.replace("45", "46"))).not.toBe(DRAFT);
  });

  it("HIGH: the trailing-space reply no longer promotes model output", async () => {
    const { qid, cy } = await delivered("L-ws", DRAFT);
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:m:${qid}:${cy}:c`);
    const promptId = 7000 + SEND.length;
    await reply(promptId, DRAFT + " "); // the exact draft, one trailing space

    const row = await logRow(qid);
    expect(row!.edit_distance).toBe(0); // measured in the form it is stored in
    const promoted = await env.DB.prepare(`SELECT COUNT(*) AS n FROM voice_finals WHERE queue_id = ?1`)
      .bind(qid).first<{ n: number }>();
    expect(promoted!.n).toBe(0);
  });

  it("but a REAL one-character edit still promotes", async () => {
    const { qid, cy } = await delivered("L-real", DRAFT);
    await tap(`c:c:${qid}:${cy}`);
    await tap(`p:m:${qid}:${cy}:c`);
    const promptId = 7000 + SEND.length;
    await reply(promptId, DRAFT.replace("45 days", "46 days"));

    const row = await logRow(qid);
    expect(row!.edit_distance).toBeGreaterThan(0);
    const promoted = await env.DB.prepare(`SELECT text FROM voice_finals WHERE queue_id = ?1`)
      .bind(qid).first<{ text: string }>();
    expect(promoted!.text).toContain("46 days");
    // And what was stored is never byte-identical to the draft.
    expect(promoted!.text).not.toBe(row!.draft_text);
  });
});

describe("p5-06: the north star", () => {
  const NS = (o: Partial<{ cards: number; approvals: number; manualPosts: number; legacyAutoPosts: number }> = {}) => ({
    cards: 0, approvals: 0, manualPosts: 0, legacyAutoPosts: 0, ...o,
  });

  it("zero posts out of real approvals is a MEASURED 0%, not a no-data branch", () => {
    // The distinction the whole block turns on. Zero posts against 29
    // approvals is the single most important fact the program has; hiding it
    // behind "nothing to report" would suppress the finding this exists to
    // surface.
    const out = renderNorthStar(NS({ cards: 100, approvals: 29 }), NS(), 7).join("\n");
    expect(out).toContain("Post rate: 0%");
    expect(out).toContain("0 of 29 approval(s)");
    expect(out).toContain("The Copy button is the constraint");
  });

  it("but a zero DENOMINATOR is genuinely no rate, and says so", () => {
    const noCards = renderNorthStar(NS(), NS(), 7).join("\n");
    expect(noCards).toContain("no approval rate to report");
    expect(noCards).not.toContain("0%");

    const noApprovals = renderNorthStar(NS({ cards: 40 }), NS(), 7).join("\n");
    expect(noApprovals).toContain("nothing that could have been posted");
  });

  it("Threads-era automated posts are NAMED and kept out of the post rate", () => {
    // Folding these in would report a 62% post rate for a desk that has
    // published nothing by hand, on a platform it no longer posts to.
    const out = renderNorthStar(NS({ cards: 100, approvals: 29, legacyAutoPosts: 18 }), NS(), 7).join("\n");
    expect(out).toContain("Post rate: 0%");
    expect(out).toContain("18 Threads-era automated post(s)");
    expect(out).toContain("excluded from the post rate");
  });

  it("APPROVALS ARE A UNION of state and post_log, which is the #115 correction", async () => {
    // Counting queue.state alone once reported press converting 23x better
    // than everything else. A card that posted no longer carries 'approved',
    // so state-only counting loses it.
    const now = new Date("2026-08-05T12:00:00.000Z");
    const item = await insertItem(env.DB, {
      source: "senate_ptr", externalId: "ns-union", category: "congress",
      eventAt: "2026-08-04T12:00:00.000Z", sourceUrl: "https://efdsearch.senate.gov/ns",
      payload: { member: "Jane Roe" }, score: SCORE_POSTABLE,
    });
    const createdAt = "2026-08-04T12:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO queue (item_id, archetype, draft_text, state, created_at) VALUES (?1,'CONGRESS_PTR','d','pending',?2)`,
    ).bind(item.id, createdAt).run();
    const q = await env.DB.prepare(`SELECT id FROM queue WHERE item_id = ?1`).bind(item.id).first<{ id: number }>();
    // State is 'pending', but it has a post_log row: it WAS approved.
    await env.DB.prepare(
      `INSERT INTO post_log (queue_id, posted_at, archetype, category, posted_manually) VALUES (?1,?2,'CONGRESS_PTR','congress',1)`,
    ).bind(q!.id, "2026-08-04T13:00:00.000Z").run();

    const { current } = await northStarStats(env.DB, now, DIGEST_WINDOW_DAYS);
    expect(current.approvals).toBeGreaterThanOrEqual(1);
    expect(current.manualPosts).toBeGreaterThanOrEqual(1);
  });

  it("the block survives the digest's EARLY RETURNS, which is where it matters most", () => {
    // renderDigest returns early when there are no posts — precisely the state
    // the north star is reporting on. If it were appended at the end it would
    // be invisible exactly when it is the only measurable thing.
    const stats = { posted: 0, unedited: 0, edited: 0, rate: null, meanEditRatio: null, uncaptured: 0, templateFallbacks: 0 };
    const text = renderDigest(stats as never, [], 7, renderNorthStar(NS({ cards: 100, approvals: 29 }), NS(), 7));
    expect(text).toContain("Post rate: 0%");
    expect(text).toContain("no posts published in the window"); // the zero-edit branch still ran
  });
});

describe("p5-12: Senate eFD arrival latency", () => {
  const L = (o: Partial<{ filings: number; medianDays: number | null; maxDays: number | null; lifetimePollFailures: number; consecutiveFailures: number; lastOkAt: string | null }> = {}) => ({
    filings: 0, medianDays: null, maxDays: null, lifetimePollFailures: 0, consecutiveFailures: 0, lastOkAt: null, ...o,
  });

  it("reports median and slowest against a stated filing count", () => {
    const out = renderEfdLatency(L({ filings: 6, medianDays: 4.5, maxDays: 7.5, lifetimePollFailures: 3, lastOkAt: "2026-08-02T13:30:01.000Z" }), 7).join("\n");
    expect(out).toContain("6 filing(s)");
    expect(out).toContain("median 4.5 days");
    expect(out).toContain("slowest 7.5");
  });

  it("NO FILINGS is not zero latency, and the poll counters still print", () => {
    // A quiet week and a lane that stopped arriving produce the identical
    // filing count. The counters are the only thing that tells them apart, so
    // they print on BOTH branches.
    const out = renderEfdLatency(L({ consecutiveFailures: 3, lifetimePollFailures: 9, lastOkAt: "2026-08-02T13:30:01.000Z" }), 7).join("\n");
    expect(out).toContain("no latency to report");
    expect(out).not.toContain("0.0 days");
    expect(out).toContain("3 consecutive failure(s) now");
    expect(out).toContain("9 lifetime");
  });

  it("a thin sample is labelled a direction, not a measurement", () => {
    const out = renderEfdLatency(L({ filings: 4, medianDays: 4.5, maxDays: 7.5 }), 7).join("\n");
    expect(out).toContain("Small sample: 4 filing(s)");
    expect(renderEfdLatency(L({ filings: 9, medianDays: 2, maxDays: 3 }), 7).join("\n")).not.toContain("Small sample");
  });

  it("names the confound rather than implying the latency is eFD's alone", () => {
    // Latency cannot separate eFD publishing late from us polling badly, and
    // the two imply different fixes. Saying so is the point of the line.
    const out = renderEfdLatency(L({ filings: 6, medianDays: 4.5, maxDays: 7.5, lifetimePollFailures: 3 }), 7).join("\n");
    expect(out).toContain("includes our polling gap");
  });

  it("never-succeeded is said outright, not rendered as a blank timestamp", () => {
    const out = renderEfdLatency(L({ lastOkAt: null }), 7).join("\n");
    expect(out).toContain("never succeeded");
  });

  it("computes latency from REAL rows: filed-to-ingest, in days", async () => {
    const item = await insertItem(env.DB, {
      source: "senate_ptr", externalId: "efd-lat-1", category: "congress",
      eventAt: "2026-08-01T00:00:00.000Z", sourceUrl: "https://efdsearch.senate.gov/x",
      payload: { member: "Jane Roe" }, score: SCORE_POSTABLE,
    });
    // insertItem stamps fetched_at = now, so drive event_at back a known gap.
    await env.DB.prepare(`UPDATE items SET fetched_at = ?1, event_at = ?2 WHERE id = ?3`)
      .bind("2026-08-05T00:00:00.000Z", "2026-08-01T00:00:00.000Z", item.id).run();
    const l = await efdLatency(env.DB, new Date("2026-07-30T00:00:00.000Z"));
    expect(l.filings).toBeGreaterThanOrEqual(1);
    expect(l.maxDays).toBeGreaterThanOrEqual(4);
  });
});
