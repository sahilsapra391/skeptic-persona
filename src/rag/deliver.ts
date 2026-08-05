import type { Env } from "../env";
import type { TickBudget } from "../lib/budget";
import { newTickBudget } from "../lib/budget";
import { sendMessage, type TgInlineButton } from "../lib/telegram";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// The copy-out card (docs/p2r-plan.md Part E): once a queue row reaches a
// terminal generation state, the owner gets ONE Telegram card per CYCLE
// carrying every valid variant (or the fallback), with Copy buttons.
//
// THE RENDER ID (added after the 30-agent card review broke the first
// version's state machine): every button carries `MAX(generations.id)` for
// the row at delivery time. AUTOINCREMENT ids are never reused, so a
// Regenerate/Edit followed by re-generation always mints a HIGHER render id.
// A tap whose render id doesn't match the live cards row is answered as
// stale and does nothing — a leftover "✅ Posted" button from a superseded
// card can no longer fabricate a post_log row (review CRITICAL #2), and the
// deliverCards-vs-webhook race resolves itself because delivery replaces any
// cards row whose render id is behind (INSERT OR REPLACE keyed on queue_id;
// finding #23).
//
// NOT THE SAME THING AS A GENERATION CYCLE, and the two used to share the
// name "cycle" three lines apart in one query. This one is a per-DELIVERY
// staleness token derived from a row id; `queue.regen_cycle` /
// `generations.cycle` is the generation PASS number that p5-01 added. Reading
// one as the other silently shows a superseded draft as copy-ready, so they
// are named apart here. Two spellings stay `cycle` for compatibility and are
// deliberately not renamed: the `cards.cycle` COLUMN (renaming it is a
// migration for no behavioural gain) and the callback_data payload shape
// `c:<v>:<qid>:<n>` (a live wire format under a 64-byte cap).
//
// Crash-safety is unchanged: a failed send writes nothing, the next tick
// retries.

export type CardVariant = "commentary" | "sharp" | "dry" | "template";

/** callback_data stays tiny (64-byte API cap): c:<c|s|d|t>:<qid>:<renderId>. */
export const VARIANT_CODE: Record<CardVariant, string> = { commentary: "c", sharp: "s", dry: "d", template: "t" };
export const CODE_VARIANT: Record<string, CardVariant> = { c: "commentary", s: "sharp", d: "dry", t: "template" };

export interface CardContent {
  readonly text: string;
  readonly buttons: TgInlineButton[][];
  readonly held: boolean;
}

interface TerminalRow {
  queue_id: number;
  archetype: string;
  terminal_status: string;
  render_id: number;
  stale_card: number;
}

interface VariantRow {
  variant: string;
  text: string;
}

/**
 * The row's LIVE generation pass. Every read of `generations` scopes to it, so
 * it is looked up ONCE and bound as a value rather than repeated as a
 * correlated subquery in each statement.
 *
 * THROWS on a missing queue row instead of returning a default. Inlined as
 * `cycle = (SELECT regen_cycle FROM queue WHERE id = ?1)`, an absent row makes
 * the comparison `cycle = NULL`, which is never true: buildCard would then find
 * zero valid variants and fall through to the template branch, rendering a
 * perfectly ordinary-looking "generation fell back" card for a row that
 * actually has valid drafts. Silent, and copy-ready. A throw is the correct
 * loudness for a state that cannot happen (both callers reach here through a
 * FK to queue.id).
 */
async function liveCycle(db: D1Database, queueId: number): Promise<number> {
  const q = await db.prepare(`SELECT regen_cycle FROM queue WHERE id = ?1`).bind(queueId).first<{ regen_cycle: number }>();
  if (!q) throw new Error(`no queue row ${queueId}: cannot resolve its generation cycle`);
  return q.regen_cycle;
}

/**
 * SINGLE HOME for "what text does this variant stand for" — the card builder
 * and the webhook's Copy/Posted handlers all resolve through here, so the
 * text the owner copies is byte-identical to the text the card displayed
 * (review findings #4/#7/#8: the webhook used to read queue text while the
 * card displayed the re-rendered fallback from generations).
 */
export async function resolveVariantText(db: D1Database, queueId: number, variant: CardVariant): Promise<string | null> {
  const cycle = await liveCycle(db, queueId);
  if (variant === "template") {
    // The fallback_template row carries the text generation actually settled
    // on (possibly re-rendered under the current budget); the raw queue text
    // is only the answer when generation never wrote one (exemplar gate).
    const g = await db
      .prepare(
        `SELECT text FROM generations
         WHERE queue_id = ?1 AND variant = 'none' AND status = 'fallback_template' AND text <> ''
           AND cycle = ?2
         ORDER BY id DESC LIMIT 1`,
      )
      .bind(queueId, cycle)
      .first<{ text: string }>();
    if (g) return g.text;
    const q = await db
      .prepare(`SELECT COALESCE(edited_text, draft_text) AS t FROM queue WHERE id = ?1`)
      .bind(queueId)
      .first<{ t: string }>();
    return q?.t ?? null;
  }
  const g = await db
    .prepare(
      `SELECT text FROM generations
       WHERE queue_id = ?1 AND variant = ?2 AND status = 'valid'
         AND cycle = ?3
       ORDER BY attempt DESC LIMIT 1`,
    )
    .bind(queueId, variant, cycle)
    .first<{ text: string }>();
  return g?.text ?? null;
}

export async function buildCard(
  db: D1Database,
  queueId: number,
  archetype: string,
  terminalStatus: string,
  renderId: number,
): Promise<CardContent> {
  const sections: string[] = [];
  const copyRow: TgInlineButton[] = [];
  const actionRow: TgInlineButton[] = [
    { text: "✏️ Edit", callback_data: `ce:${queueId}:${renderId}` },
    { text: "🔁 Regenerate", callback_data: `g:${queueId}:${renderId}` },
  ];

  if (terminalStatus === "fallback_blocked") {
    return {
      text: `🛑 #${queueId} ${archetype}\n\nHELD: generation failed and the template fallback fails the register. Nothing here is copy-ready — Edit to fix the text, or Regenerate.`,
      buttons: [actionRow],
      held: true,
    };
  }
  if (terminalStatus === "rejected:payload") {
    // Stranded-row fix (findings #12/#17/#20): unparseable payload is
    // terminal for generation, but the owner still gets a handle.
    return {
      text: `🛑 #${queueId} ${archetype}\n\nHELD: this item's stored payload does not parse, so nothing can be generated or rendered from it. This needs a code/data fix; Regenerate will retry after one lands.`,
      buttons: [[{ text: "🔁 Regenerate", callback_data: `g:${queueId}:${renderId}` }]],
      held: true,
    };
  }

  if (terminalStatus === "valid") {
    // Scoped to the CURRENT cycle (p5-01). History is append-only now, so an
    // unscoped read would blend cycles: if this cycle produced only `dry`, the
    // card would pair it with a `commentary` from the pass the owner already
    // rejected, and present the mix as one draft set.
    const rows = await db
      .prepare(
        `SELECT variant, text FROM generations
         WHERE queue_id = ?1 AND status = 'valid' AND variant <> 'none'
           AND cycle = ?2
         ORDER BY attempt ASC`,
      )
      .bind(queueId, await liveCycle(db, queueId))
      .all<VariantRow>();
    const latest = new Map<string, string>();
    for (const r of rows.results) latest.set(r.variant, r.text);
    // Commentary first: it is THE deliverable; dry is the last resort.
    for (const v of ["commentary", "sharp", "dry"] as const) {
      const text = latest.get(v);
      if (!text) continue;
      sections.push(`— ${v} —\n${text}`);
      copyRow.push({ text: `Copy ${v}`, callback_data: `c:${VARIANT_CODE[v]}:${queueId}:${renderId}` });
    }
  }

  if (copyRow.length === 0) {
    const text = await resolveVariantText(db, queueId, "template");
    const label =
      terminalStatus === "skipped_no_exemplar"
        ? `template draft (no exemplar for ${archetype} yet — write one to enable generation)`
        : "template draft (generation fell back)";
    sections.push(`— ${label} —\n${text ?? ""}`);
    copyRow.push({ text: "Copy draft", callback_data: `c:t:${queueId}:${renderId}` });
  }

  return {
    text: `#${queueId} ${archetype} — pick a variant, paste to X, then answer Posted?\n\n${sections.join("\n\n")}`,
    buttons: [copyRow, actionRow],
    held: false,
  };
}

/** The Posted? keyboard carries the VARIANT whose text was copied, so the
 *  answer records the text of the prompt the owner is actually answering —
 *  chosen_variant as a mutable slot let Copy A / Copy B / tap A's prompt
 *  record B's text (review finding #3). */
export function postedButtons(queueId: number, renderId: number, variant: CardVariant): TgInlineButton[][] {
  const v = VARIANT_CODE[variant];
  return [[
    { text: "✅ Posted", callback_data: `p:y:${queueId}:${renderId}:${v}` },
    { text: "✏️ Posted, edited", callback_data: `p:m:${queueId}:${renderId}:${v}` },
    { text: "⏭ Skipped", callback_data: `p:k:${queueId}:${renderId}:${v}` },
  ]];
}

/**
 * Deliver cards for queue rows whose generation reached a terminal state and
 * whose live cards row (if any) carries an older render id.
 *
 * BOTH counters appear in the query below, which is why they are now spelled
 * differently. `MAX(g.id) AS render_id` is the delivery staleness token;
 * `g.cycle = q.regen_cycle` scopes the join to the row's live generation pass.
 * `c.cycle` is the cards COLUMN, which still holds a render id under a legacy
 * name.
 */
export async function deliverCards(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const due = await env.DB.prepare(
    `SELECT q.id AS queue_id, q.archetype,
            g.status AS terminal_status,
            MAX(g.id) AS render_id,
            COALESCE(c.cycle, -1) <> MAX(g.id) AND c.queue_id IS NOT NULL AS stale_card
     FROM queue q
     JOIN generations g ON g.queue_id = q.id
       AND g.cycle = q.regen_cycle
       AND (g.status = 'valid' OR g.status LIKE 'fallback%' OR g.status LIKE 'skipped%' OR g.status = 'rejected:payload')
     LEFT JOIN cards c ON c.queue_id = q.id
     WHERE q.state IN ('approved', 'edited')
       AND (c.posted_state IS NULL OR c.posted_state = 'skipped')
     GROUP BY q.id
     HAVING c.queue_id IS NULL OR c.cycle <> MAX(g.id)
     ORDER BY q.decided_at
     LIMIT 5`,
  ).all<TerminalRow>();

  for (const row of due.results) {
    if (!budget.take(1, { reserved: true })) break;
    const card = await buildCard(env.DB, row.queue_id, row.archetype, row.terminal_status, row.render_id);
    let messageId: number | null = null;
    try {
      const sent = await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, card.text, { buttons: card.buttons });
      messageId = sent.message_id;
    } catch (e) {
      log("error", "card delivery failed; will retry", { queueId: row.queue_id, error: String(e) });
      continue;
    }
    // OR REPLACE: a stale row (including one INSERTed by a delivery that raced
    // a Regenerate) is superseded, never a blocker. `cards.cycle` is the
    // legacy column name for what the code now calls a render id.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO cards (queue_id, telegram_message_id, delivered_at, cycle) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(row.queue_id, messageId, iso(now), row.render_id)
      .run();
    log("info", "card delivered", { queueId: row.queue_id, renderId: row.render_id, held: card.held, replacedStale: Boolean(row.stale_card) });
  }
}
