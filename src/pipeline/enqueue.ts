import type { Env } from "../env";
import { createQueueEntry, setQueueTelegramMessageId } from "../lib/db";
import { sendMessage, TelegramError } from "../lib/telegram";
import { renderForQueue } from "../templates";
import type { ArchetypeId, Payload } from "../templates/types";
import { log } from "../lib/log";
import {
  DEFAULT_CAP_BYPASS_SCORE,
  DEFAULT_CATEGORY_CAP,
  DEFAULT_SALIENCE_FLOOR,
  parseCategoryCaps,
  salienceFor,
} from "../salience";
import { holdForDigest, pushedTodayByCategory } from "../digest";

/**
 * Decide whether an item is held for the digest. Returns the hold reason, or
 * null to push.
 *
 * Fail-OPEN by construction: any throw inside leaves the item pushing. A
 * curation bug must cost noise, never silence — the owner can ignore a card
 * he did not need, but he cannot approve one he never saw.
 */
async function salienceHold(
  env: Env,
  itemId: number,
  archetype: ArchetypeId,
  payload: Payload,
  now: Date,
): Promise<"below_floor" | "category_cap" | null> {
  try {
    // Clamped to the score range: salienceFor caps at 100, so a fat-fingered
    // SALIENCE_FLOOR="450" would silently hold EVERY item in every category.
    const rawFloor = Number(env.SALIENCE_FLOOR ?? DEFAULT_SALIENCE_FLOOR);
    const floor =
      Number.isFinite(rawFloor) && rawFloor >= 0 && rawFloor <= 100 ? rawFloor : DEFAULT_SALIENCE_FLOOR;
    if (floor !== rawFloor) log("warn", "SALIENCE_FLOOR out of range; using default", { raw: env.SALIENCE_FLOOR ?? null, floor });
    const { score, reasons, exempt } = salienceFor(archetype, payload);

    if (!exempt && score < floor) {
      log("info", "held for digest: below floor", { itemId, archetype, score, floor, reasons });
      await holdForDigest(env, itemId, archetype, score, "below_floor", now);
      return "below_floor";
    }
    // Exempt categories (owner amendment 2026-08-01) ignore the ceiling
    // entirely: "a hard cap that drops a congress PTR because a quiet
    // category already filled the day is the failure mode to avoid."
    if (exempt) return null;

    // Strong items ignore the ceiling: caps are first-come-first-served, so
    // without this a high-salience afternoon filing loses to a weak morning one.
    // >= 0, not > 0: CAP_BYPASS_SCORE=0 is a real setting meaning "no daily
    // caps at all" (every score clears it), which is how the test env turns
    // curation off. Only a negative or unparseable value is a typo.
    const rawBypass = Number(env.CAP_BYPASS_SCORE ?? DEFAULT_CAP_BYPASS_SCORE);
    const bypass = Number.isFinite(rawBypass) && rawBypass >= 0 ? rawBypass : DEFAULT_CAP_BYPASS_SCORE;
    if (score >= bypass) return null;

    const { caps, skipped } = parseCategoryCaps(env.CATEGORY_DAILY_CAPS);
    if (skipped.length > 0) log("warn", "invalid CATEGORY_DAILY_CAPS entries skipped", { skipped });
    const cap = caps[archetype] ?? DEFAULT_CATEGORY_CAP;
    const pushed = await pushedTodayByCategory(env.DB, archetype, now);
    if (pushed >= cap) {
      log("info", "held for digest: category cap", { itemId, archetype, score, pushed, cap });
      await holdForDigest(env, itemId, archetype, score, "category_cap", now);
      return "category_cap";
    }
    return null;
  } catch (e) {
    log("error", "salience gate failed; pushing the item", { itemId, archetype, error: String(e) });
    return null;
  }
}

export interface EnqueueResult {
  queueId: number;
  notified: boolean;
  /** Set when Telegram flood control pushed back — callers should stop batching. */
  retryAfter: number | null;
  /** p4-03: the item was held for the daily digest instead of pushed. Not an
   *  error — callers keep draining, exactly as they do for queueId 0. */
  held?: "below_floor" | "category_cap";
}

export interface EnqueueOptions {
  /** Digest promotion re-enters this path; the item already lost once on
   *  salience and the owner has explicitly asked for it, so the gate is
   *  skipped rather than re-litigated. */
  bypassSalience?: boolean;
}

/**
 * Put an item's draft into the approval queue and surface it in Telegram
 * with Approve / Edit / Reject buttons. Ingesters (PR-3+) call this for
 * every postable item while the category is approval-gated.
 *
 * If Telegram env isn't configured yet, the queue row is still created
 * (state pending) so nothing is lost — it will simply expire un-notified.
 */
export async function enqueueForApproval(
  env: Env,
  itemId: number,
  archetype: ArchetypeId,
  payload: Payload,
  sourceUrl: string,
  now: Date = new Date(),
  seed?: string,
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  // SALIENCE GATE (p4-03). One gate for all 20 call sites, ahead of the
  // render so a held item costs nothing. Measured 2026-08-01: 181 cards/day
  // against a 25/day target, 2.18% lifetime approval, zero approvals across
  // the last three full days. Held items are NOT dropped — they are marked
  // 'digested', listed in the day's roll-up, and promotable from it.
  if (!opts.bypassSalience) {
    const held = await salienceHold(env, itemId, archetype, payload, now);
    if (held) return { queueId: 0, notified: false, retryAfter: null, held };
  }
  // RENDER AT ENQUEUE TIME (persona.md: what Sahil approves is byte-identical
  // to what posts). Deterministic seed = the item's identity, so a re-render
  // produces the same text.
  //
  // Wrapped, because renderForQueue THROWS on a malformed payload rather than
  // returning ok:false — round three found that, round four guarded
  // promoteHeldItem for it, and this call stayed bare through both. It is
  // byte-identical to main, so not a regression, but it is the third time the
  // same helper has bitten a caller and the second time I fixed one path and
  // left its neighbour.
  //
  // Concrete: payload {items:[{code:'4.02'}], cik:'1', company:'A Co'} scores
  // 95, clears the floor, and throws TypeError out of firstClause because
  // title is undefined. The item stays at status='new', so the drain's
  // `WHERE status='new' ORDER BY id LIMIT 5` re-selects it every poll forever
  // — a head-of-line block on the whole source, plus a markUnhealthy on each
  // pass from the ingester's outer catch. Parking it as 'logged' is the same
  // remedy the ok:false branch already applies, for the same reason.
  let rendered: Awaited<ReturnType<typeof renderForQueue>>;
  try {
    rendered = await renderForQueue(env, archetype, payload, seed ?? `${archetype}:${itemId}`);
  } catch (e) {
    await env.DB.prepare(`UPDATE items SET status = 'logged' WHERE id = ?1`).bind(itemId).run().catch(() => {});
    log("error", "render threw; item parked as logged so it cannot block its source", {
      itemId,
      archetype,
      error: String(e),
    });
    return { queueId: 0, notified: false, retryAfter: null };
  }
  if (!rendered.ok) {
    // Park it in the lake rather than leaving status='new': the drain query
    // is ORDER BY id LIMIT N, so an unrenderable row would head-of-line block
    // its entire source forever.
    await env.DB.prepare(`UPDATE items SET status = 'logged' WHERE id = ?1`).bind(itemId).run().catch(() => {});
    log("error", "render failed; item parked as logged", { itemId, archetype, reason: rendered.reason });
    return { queueId: 0, notified: false, retryAfter: null };
  }
  const draftText = rendered.text;

  // PERSIST THE PAYLOAD THAT WAS ACTUALLY RENDERED. Enrichers (the lookback
  // engine in edgar8k) add fields to the in-memory payload on the way here,
  // and those fields were never written back — so items.payload did NOT match
  // what produced the draft. That breaks the determinism claim three lines
  // up: a re-render from D1 would see no lookback fields, could pick a
  // different beat, and would produce different text from what the owner
  // approved. It also made every lookback-gated beat unreachable to anything
  // reading the payload later (the RAG generation prompt reads it).
  //
  // Doing it here rather than in each enricher so a future enricher inherits
  // it. Non-fatal: a failed write costs a stale payload, not a lost post.
  await env.DB.prepare(`UPDATE items SET payload = ?1 WHERE id = ?2`)
    .bind(JSON.stringify(payload), itemId)
    .run()
    .catch((e: unknown) => log("warn", "payload write-back failed", { itemId, error: String(e) }));

  const queueId = await createQueueEntry(env.DB, itemId, archetype, draftText, now, {
    skeletonId: rendered.skeletonId,
    beatId: rendered.beatId,
  });

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log("warn", "telegram not configured; queue entry created without notification", { queueId });
    return { queueId, notified: false, retryAfter: null };
  }

  const text = `#${queueId} · ${archetype}\n\n${draftText}\n\nSource: ${sourceUrl}`;
  try {
    const msg = await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text, {
      buttons: [
        [
          { text: "✅ Approve", callback_data: `a:${queueId}` },
          { text: "✏️ Edit", callback_data: `e:${queueId}` },
          { text: "❌ Reject", callback_data: `r:${queueId}` },
        ],
      ],
    });
    await setQueueTelegramMessageId(env.DB, queueId, msg.message_id);
    return { queueId, notified: true, retryAfter: null };
  } catch (e) {
    // Queue row survives; the expiry job will sweep it if nobody notices.
    log("error", "telegram notify failed", { queueId, error: String(e) });
    const retryAfter = e instanceof TelegramError ? e.retryAfter : null;
    return { queueId, notified: false, retryAfter };
  }
}
