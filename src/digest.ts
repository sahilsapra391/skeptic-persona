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

// NOTE: there is deliberately no DIGEST_MAX_BUTTONS. Every listed line gets a
// promote button, unconditionally. A button cap below the line cap showed an
// item once, invited promotion, then marked it sent so it could never be
// promoted or re-listed — the "held is not lost" guarantee held for only the
// first few. callback_data is 24 bytes against a 64-byte limit, so the
// constraint was never encoding.

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

function summarise(archetype: string, count: number, day: string, today: string): string {
  const noun = count === 1 ? "item" : "items";
  // Deliberately does NOT say "below the push bar": a row held by the daily
  // cap can score 79 against a floor of 45, and this repo insists that
  // distinction is load-bearing ('digested' is not 'logged' precisely because
  // "met the bar, lost the slot" must stay distinguishable). This is copy the
  // owner may screenshot, so it states what happened, not why.
  // A rolled-over group sends on a LATER day, so "today" would be a false
  // claim about when they were held.
  const when = day === today ? "today" : `on ${day}`;
  return `Held back ${when}: ${count} ${archetype} ${noun} not pushed.`;
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
      // renderForQueue can THROW, not just return ok:false — a skeleton that
      // dereferences a field this payload lacks raises rather than declining
      // (firstClause on a missing 8-K title, for one). Unwrapped, one bad row
      // takes down the digest for EVERY category, which is the failure this
      // whole chunk exists to prevent.
      let rendered: Awaited<ReturnType<typeof renderForQueue>>;
      try {
        rendered = await renderForQueue(env, h.archetype as ArchetypeId, payload, `digest:${h.item_id}`);
      } catch (e) {
        log("warn", "digest render threw; row retired", { itemId: h.item_id, archetype: h.archetype, error: String(e) });
        skipped.push(h.id);
        continue;
      }
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
      // Every row failed to render. TELL HIM FIRST, retire second: retiring
      // before the alert let a whole category vanish on a Telegram 429 — rows
      // came back marked sent, items stayed 'digested' and out of every
      // drain, and the only trace was a warn nobody reads. If he cannot be
      // told, the rows stay unsent and the next run tries again. Noisy beats
      // silent, which is this chunk's whole thesis.
      if (skipped.length > 0) {
        const n = held.results.length;
        let told = false;
        try {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `⚠️ ${n} ${g.archetype} ${n === 1 ? "item was" : "items were"} held on ${g.day}, but none could be rendered, so there is no digest card. ${n === 1 ? "It is" : "They are"} retired; see the log for the item ${n === 1 ? "id" : "ids"}.`,
          );
          told = true;
        } catch (e) {
          log("error", "could not tell the owner about an unrenderable digest group; rows left for the next run", {
            day: g.day,
            archetype: g.archetype,
            error: String(e),
          });
          // Same flood-control backoff the renderable send path has. Review
          // found this branch had neither the backoff nor the pacing, and the
          // condition that makes MANY groups unrenderable at once is a
          // template or payload regression — precisely when this runs for
          // every category in turn. Measured: five unrenderable groups against
          // a 429 produced five back-to-back sends, while three renderable
          // groups against the same 429 produced one and returned.
          //
          // Returning, not continuing: the rows keep sent_at NULL and the next
          // run retries them unchanged, which is what `told = false` already
          // guarantees below.
          if (e instanceof TelegramError && e.retryAfter !== null) return;
        }
        log("error", "digest group unrenderable", {
          day: g.day,
          archetype: g.archetype,
          rows: skipped.length,
          retired: told,
          itemIds: held.results.map((h) => h.item_id),
        });
        if (told) {
          await env.DB.prepare(
            `UPDATE digest_items SET sent_at = ?1 WHERE id IN (${skipped.map(() => "?").join(",")})`,
          )
            .bind(iso(now), ...skipped)
            .run()
            .catch(() => {});
        }
      }
      continue;
    }

    // Every held row is accounted for in the message: listed, rolled over to
    // the next run, or retired unrenderable. An earlier version subtracted
    // `skipped` from the count and printed nothing for it, so a group whose
    // top scorer failed to render showed "5 items" above 4 lines with no
    // "+N" — a silently cut list reading as complete, which is the exact
    // class this file's own doctrine comment forbids.
    const rolled = held.results.length - lines.length - skipped.length;
    const body = [
      summarise(g.archetype, held.results.length, g.day, etDay(now)),
      "",
      ...lines,
      // Truncation is ALWAYS announced: a silently cut list reads as complete.
      ...(rolled > 0 ? [`+${rolled} more held, in tomorrow's roll-up.`] : []),
      ...(skipped.length > 0
        ? [
            skipped.length === 1
              ? "1 could not be rendered and was retired; see the log for its item id."
              : `${skipped.length} could not be rendered and were retired; see the log for their item ids.`,
          ]
        : []),
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
      log("info", "digest sent", { day: g.day, archetype: g.archetype, listed: lines.length, rolled });
      if (skipped.length > 0) {
        // ERROR, with ids: a retired row is out of every drain, has no card
        // and is never re-listed, so the log line is its only handle.
        log("error", "digest retired unrenderable rows", {
          day: g.day,
          archetype: g.archetype,
          itemIds: held.results.filter((h) => skipped.includes(h.id)).map((h) => h.item_id),
        });
      }
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
  // Flip the item OUT of 'digested' FIRST. enqueueForApproval creates the
  // queue row before it notifies Telegram, so a flood-control throw leaves a
  // real card behind while returning an error — and a second tap would then
  // build another one. Keying promotion off the item status makes the second
  // tap a no-op regardless of how the first ended.
  const claimed = await env.DB.prepare(`UPDATE items SET status = 'new' WHERE id = ?1 AND status = 'digested'`)
    .bind(itemId)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return null; // someone already promoted it

  // enqueueForApproval calls renderForQueue, which THROWS on some payloads —
  // documented in this same file for the digest path and then left unguarded
  // here, which is the neighbouring-path mistake for the fourth time in this
  // chunk. It also parks the item as 'logged' itself when a render merely
  // declines, so a restore that only matches 'new' is dead code wearing a
  // safety net's comment.
  let res: Awaited<ReturnType<typeof enqueueForApproval>> | null = null;
  try {
    res = await enqueueForApproval(env, itemId, row.archetype as ArchetypeId, payload, row.source_url, now, undefined, {
      bypassSalience: true,
    });
  } catch (e) {
    log("error", "promotion threw; restoring the item so the button still works", { itemId, error: String(e) });
  }
  if (!res || res.queueId === 0) {
    // Restore from WHATEVER state the failed attempt left: 'new' on a throw,
    // 'logged' when enqueue parked an unrenderable payload. A second tap then
    // retries instead of finding the item stranded outside every drain.
    await env.DB.prepare(`UPDATE items SET status = 'digested' WHERE id = ?1 AND status IN ('new', 'logged')`)
      .bind(itemId)
      .run()
      .catch(() => {});
    return null;
  }
  return { queueId: res.queueId, archetype: row.archetype };
}

/** True when the rendered text still fits the post budget — promotion must
 *  not resurrect an item that can no longer render inside 280. */
export function promotable(text: string): boolean {
  return fitsInPost(text);
}
