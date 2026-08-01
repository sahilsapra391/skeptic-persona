import type { Env } from "./env";
import { newTickBudget, type TickBudget } from "./lib/budget";
import { sendMessage, TelegramError, type TgInlineButton } from "./lib/telegram";
import { iso, ET, zonedParts, zonedTimeToUtc } from "./lib/time";
import { log } from "./lib/log";
import { renderForQueue } from "./templates";
import type { ArchetypeId, Payload } from "./templates/types";
import { fitsInPost } from "./templates/length";

// DIGESTS — the other half of curation. Salience decides what pushes; this
// tells the owner, once a day, what it held back and lets him pull anything
// out of the pile.
//
// DOCTRINE, because a digest is published-shaped copy the owner may screenshot:
//  - Every line is an item's OWN rendered fact line, which already carries
//    its attribution (render.ts welds it onto line 0). Nothing here composes
//    a new claim, so there is no new fabrication surface and no LLM call.
//  - The header states what it is: items WE held back today. It never says
//    "nothing else happened" — absence in our lake is not absence in the
//    world (persona.md).
//  - Truncation is always announced ("+N more"). Silently cutting a list is
//    the House-PTR bug class: a partial list reads as complete.

/** Lines per digest message. 4,096-char Telegram clamp is silent, so the cap
 *  is ours and explicit; the longest observed first lines (~197 chars) still
 *  fit 12 lines plus header inside the clamp with room to spare. */
export const DIGEST_MAX_LINES = 12;

/** One promote button per listed line — deliberately NOT a smaller cap.
 *  Capping buttons below lines showed an item once, invited promotion, then
 *  marked it sent so it could never be promoted or re-listed: the "held is
 *  not lost" guarantee held for only the first few. callback_data is 24 bytes
 *  against a 64-byte limit, so the constraint is layout, not encoding. */
export const DIGEST_MAX_BUTTONS = DIGEST_MAX_LINES;

/** Telegram renders a single long button row unusably on mobile; four per
 *  row matches the copy-card layout. */
function chunkButtons(all: TgInlineButton[]): TgInlineButton[][] {
  const rows: TgInlineButton[][] = [];
  for (let i = 0; i < all.length; i += 4) rows.push(all.slice(i, i + 4));
  return rows;
}

export function etDay(now: Date): string {
  const p = zonedParts(now, ET);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export interface HeldItem {
  id: number;
  archetype: string;
  score: number;
  reason: string;
  payload: string;
  item_id: number;
}

/**
 * Record an item as held back. Marks the item 'digested' (which removes it
 * from every ingester drain) and adds it to the roll-up worklist.
 *
 * Idempotent on item_id: a re-processed item never doubles a digest line.
 */
export async function holdForDigest(
  env: Env,
  itemId: number,
  archetype: string,
  score: number,
  reason: "below_floor" | "category_cap",
  now: Date,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO digest_items (item_id, archetype, day, score, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(itemId, archetype, etDay(now), Math.round(score), reason, iso(now)),
    // 'digested' is distinct from 'logged' on purpose: logged never met the
    // bar, digested met it and lost the slot. Only digested rows promote.
    env.DB.prepare(`UPDATE items SET status = 'digested' WHERE id = ?1 AND status IN ('new', 'queued')`).bind(itemId),
  ]);
}

/** The UTC instant of ET midnight for the ET day containing `now`. DST-safe
 *  via the same helper the cadence layer uses, so the cap window and the
 *  digest's `day` key can never disagree. */
export function etDayStartUtc(now: Date): Date {
  const p = zonedParts(now, ET);
  return zonedTimeToUtc(ET, p.year, p.month, p.day, 0, 0);
}

/** Count cards already pushed today for a category, read from the queue
 *  itself — no counter table to drift, and it self-heals if a row is
 *  deleted or the day rolls over mid-tick. */
export async function pushedTodayByCategory(db: D1Database, archetype: string, now: Date): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM queue WHERE archetype = ?1 AND created_at >= ?2`)
    .bind(archetype, iso(etDayStartUtc(now)))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function summarise(archetype: string, count: number): string {
  const noun = count === 1 ? "item" : "items";
  return `Held back today: ${count} ${archetype} ${noun} below the push bar.`;
}

/**
 * Send one roll-up per (day, archetype) with unsent held items. Runs daily at
 * 21:00 ET. Never throws: a Telegram failure leaves sent_at NULL so the next
 * run retries, and a partial batch is safe because marking is per-message.
 */
export async function pushDigests(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log("warn", "digest push skipped: telegram not configured");
    return;
  }
  const groups = await env.DB.prepare(
    `SELECT day, archetype, COUNT(*) AS n FROM digest_items
     WHERE sent_at IS NULL
     GROUP BY day, archetype
     ORDER BY day, archetype`,
  ).all<{ day: string; archetype: string; n: number }>();

  for (const g of groups.results) {
    if (!budget.take(1)) {
      log("warn", "digest push: tick budget exhausted; remaining groups defer");
      return;
    }
    const held = await env.DB.prepare(
      `SELECT d.id, d.item_id, d.archetype, d.score, d.reason, i.payload
       FROM digest_items d JOIN items i ON i.id = d.item_id
       WHERE d.sent_at IS NULL AND d.day = ?1 AND d.archetype = ?2
       ORDER BY d.score DESC, d.id ASC`,
    )
      .bind(g.day, g.archetype)
      .all<HeldItem>();
    if (held.results.length === 0) continue;

    const lines: string[] = [];
    const buttons: TgInlineButton[] = [];
    // The ids ACTUALLY listed. Never a positional prefix of held.results: the
    // loop skips rows that fail to parse or render, so a prefix marks rows
    // that were never shown — losing the highest-scoring item silently while
    // re-listing a lower one forever.
    const listedIds: number[] = [];
    const skipped: number[] = [];
    for (const h of held.results) {
      if (lines.length >= DIGEST_MAX_LINES) break;
      let payload: Payload;
      try {
        payload = JSON.parse(h.payload) as Payload;
      } catch {
        skipped.push(h.id); // an unparseable payload is not worth a digest line
        continue;
      }
      // The item's OWN fact line, attribution welded on by the renderer.
      const rendered = await renderForQueue(env, h.archetype as ArchetypeId, payload, `digest:${h.item_id}`);
      if (!rendered.ok) {
        skipped.push(h.id);
        continue;
      }
      const first = rendered.text.split("\n")[0] ?? "";
      if (!first) {
        skipped.push(h.id);
        continue;
      }
      lines.push(`${lines.length + 1}. ${first}`);
      listedIds.push(h.id);
      // Every listed line gets a promote button. Capping buttons below lines
      // would show an item once and then leave it unpromotable forever, since
      // it is marked sent and never re-listed.
      buttons.push({ text: `↑ ${lines.length}`, callback_data: `dg:${h.item_id}` });
    }
    if (lines.length === 0) {
      // Every row in this group failed to render. Marking them prevents an
      // infinite silent retry; the loud log is how it reaches a human.
      if (skipped.length > 0) {
        await env.DB.prepare(
          `UPDATE digest_items SET sent_at = ?1 WHERE id IN (${skipped.map(() => "?").join(",")})`,
        )
          .bind(iso(now), ...skipped)
          .run()
          .catch(() => {});
        log("error", "digest group unrenderable; rows retired without a card", {
          day: g.day,
          archetype: g.archetype,
          rows: skipped.length,
        });
      }
      continue;
    }

    const omitted = held.results.length - lines.length - skipped.length;
    const body = [
      summarise(g.archetype, held.results.length),
      "",
      ...lines,
      // Truncation is ALWAYS announced: a silently cut list reads as complete.
      ...(omitted > 0 ? [`+${omitted} more held.`] : []),
      "",
      "Tap ↑ to pull one out as a full card.",
    ].join("\n");

    try {
      const msg = await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, body, {
        buttons: buttons.length > 0 ? chunkButtons(buttons) : undefined,
      });
      const sentIds = [...listedIds, ...skipped];
      // Mark ONLY what this message actually listed; anything beyond the line
      // cap stays unsent and rolls into tomorrow rather than vanishing.
      await env.DB.prepare(
        `UPDATE digest_items SET sent_at = ?1, telegram_message_id = ?2
         WHERE id IN (${sentIds.map(() => "?").join(",")})`,
      )
        .bind(iso(now), msg.message_id, ...sentIds)
        .run();
      log("info", "digest sent", { day: g.day, archetype: g.archetype, listed: lines.length, skipped: skipped.length, omitted });
      // Telegram asks for <= 1 message/s per chat; every other sender in this
      // repo paces, and a multi-category roll-up sends several in a row.
      const spacing = Number(env.QUEUE_NOTIFY_SPACING_MS ?? 1100);
      if (Number.isFinite(spacing) && spacing > 0) await new Promise((r) => setTimeout(r, spacing));
    } catch (e) {
      // sent_at stays NULL: the next run retries this group unchanged.
      log("error", "digest send failed", { day: g.day, archetype: g.archetype, error: String(e) });
      if (e instanceof TelegramError && e.retryAfter !== null) return;
    }
  }
}

/**
 * Promote a held item back into the approval queue as a full card. Used by
 * the digest's ↑ buttons. Returns the new queue id, or null when the item is
 * gone, already promoted, or no longer renderable.
 */
export async function promoteHeldItem(
  env: Env,
  itemId: number,
  now: Date,
): Promise<{ queueId: number; archetype: string } | null> {
  const row = await env.DB.prepare(
    `SELECT d.archetype, i.payload, i.source_url, i.status
     FROM digest_items d JOIN items i ON i.id = d.item_id
     WHERE d.item_id = ?1`,
  )
    .bind(itemId)
    .first<{ archetype: string; payload: string; source_url: string; status: string }>();
  if (!row || row.status !== "digested") return null;

  let payload: Payload;
  try {
    payload = JSON.parse(row.payload) as Payload;
  } catch {
    return null;
  }
  // Promotion goes through the ordinary enqueue path so the card, rotation
  // ledger and generation lifecycle are identical to any other item. The
  // import is local to avoid a cycle (enqueue imports salience, salience is
  // imported here).
  const { enqueueForApproval } = await import("./pipeline/enqueue");
  const res = await enqueueForApproval(env, itemId, row.archetype as ArchetypeId, payload, row.source_url, now, undefined, {
    bypassSalience: true,
  });
  if (res.queueId === 0) return null;
  return { queueId: res.queueId, archetype: row.archetype };
}

/** True when the rendered text still fits the post budget — promotion must
 *  not resurrect an item that can no longer render inside 280. */
export function promotable(text: string): boolean {
  return fitsInPost(text);
}
