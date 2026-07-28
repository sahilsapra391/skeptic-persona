import type { Env } from "../env";
import type { TickBudget } from "../lib/budget";
import { newTickBudget } from "../lib/budget";
import { sendMessage, type TgInlineButton } from "../lib/telegram";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// The copy-out card (docs/p2r-plan.md Part E): once a queue row reaches a
// terminal generation state, the owner gets ONE Telegram card carrying every
// valid variant (or the template fallback), with Copy buttons. Tapping Copy
// answers with the chosen text as a monospace pre block — one-tap copy on
// mobile — and swaps the card's keyboard to the Posted? capture.
//
// Crash-safety is the cards row's ABSENCE: a failed send inserts nothing, so
// the next tick retries. Same selection shape as the generation lifecycle.
//
// fallback_blocked rows get a HELD card with no copy buttons: the row's
// alert already fired, and the card exists so the owner has a handle to
// Edit/Regenerate from, not so they can copy something broken.

export type CardVariant = "commentary" | "sharp" | "dry" | "template";

/** callback_data stays tiny (64-byte API cap): c:<c|s|d|t>:<qid>. */
export const VARIANT_CODE: Record<CardVariant, string> = { commentary: "c", sharp: "s", dry: "d", template: "t" };
export const CODE_VARIANT: Record<string, CardVariant> = { c: "commentary", s: "sharp", d: "dry", t: "template" };

export interface CardContent {
  readonly text: string;
  readonly buttons: TgInlineButton[][];
  /** variant -> copyable text; what the Copy tap answers with. */
  readonly copyable: Partial<Record<CardVariant, string>>;
  readonly held: boolean;
}

interface TerminalRow {
  queue_id: number;
  archetype: string;
  terminal_status: string;
  fallback_text: string;
}

interface VariantRow {
  variant: string;
  text: string;
}

export async function buildCard(db: D1Database, queueId: number, archetype: string, terminalStatus: string, fallbackText: string): Promise<CardContent> {
  const copyable: Partial<Record<CardVariant, string>> = {};
  const sections: string[] = [];
  const copyRow: TgInlineButton[] = [];

  if (terminalStatus === "valid") {
    // Latest valid text per variant (highest attempt wins).
    const rows = await db
      .prepare(
        `SELECT variant, text FROM generations
         WHERE queue_id = ?1 AND status = 'valid' AND variant <> 'none'
         ORDER BY attempt ASC`,
      )
      .bind(queueId)
      .all<VariantRow>();
    const latest = new Map<string, string>();
    for (const r of rows.results) latest.set(r.variant, r.text);
    // Commentary first: it is THE deliverable; dry is the last resort.
    for (const v of ["commentary", "sharp", "dry"] as const) {
      const text = latest.get(v);
      if (!text) continue;
      copyable[v] = text;
      sections.push(`— ${v} —\n${text}`);
      copyRow.push({ text: `Copy ${v}`, callback_data: `c:${VARIANT_CODE[v]}:${queueId}` });
    }
  }

  if (terminalStatus === "fallback_blocked") {
    return {
      text: `🛑 #${queueId} ${archetype}\n\nHELD: generation failed and the template fallback fails the register. Nothing here is copy-ready — Edit to fix the text, or Regenerate.`,
      buttons: [[
        { text: "✏️ Edit", callback_data: `ce:${queueId}` },
        { text: "🔁 Regenerate", callback_data: `g:${queueId}` },
      ]],
      copyable,
      held: true,
    };
  }

  if (copyRow.length === 0) {
    // fallback_template / skipped_no_exemplar: the template draft stands.
    copyable.template = fallbackText;
    const label = terminalStatus === "skipped_no_exemplar" ? "template draft (no exemplar for this archetype yet)" : "template draft (generation fell back)";
    sections.push(`— ${label} —\n${fallbackText}`);
    copyRow.push({ text: "Copy draft", callback_data: `c:t:${queueId}` });
  }

  return {
    text: `#${queueId} ${archetype} — pick a variant, paste to X, then answer Posted?\n\n${sections.join("\n\n")}`,
    buttons: [copyRow, [
      { text: "✏️ Edit", callback_data: `ce:${queueId}` },
      { text: "🔁 Regenerate", callback_data: `g:${queueId}` },
    ]],
    copyable,
    held: false,
  };
}

export const POSTED_BUTTONS: TgInlineButton[][] = [];

export function postedButtons(queueId: number): TgInlineButton[][] {
  return [[
    { text: "✅ Posted", callback_data: `p:y:${queueId}` },
    { text: "✏️ Posted, edited", callback_data: `p:m:${queueId}` },
    { text: "⏭ Skipped", callback_data: `p:k:${queueId}` },
  ]];
}

/**
 * Deliver cards for queue rows whose generation reached a terminal state.
 * Runs inside the generation job's tick, after runGeneration.
 */
export async function deliverCards(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const due = await env.DB.prepare(
    `SELECT q.id AS queue_id, q.archetype,
            g.status AS terminal_status,
            COALESCE(NULLIF(g.text, ''), COALESCE(q.edited_text, q.draft_text)) AS fallback_text
     FROM queue q
     JOIN generations g ON g.queue_id = q.id
       AND (g.status = 'valid' OR g.status LIKE 'fallback%' OR g.status LIKE 'skipped%')
     LEFT JOIN cards c ON c.queue_id = q.id
     WHERE q.state IN ('approved', 'edited') AND c.queue_id IS NULL
     GROUP BY q.id
     ORDER BY q.decided_at
     LIMIT 5`,
  ).all<TerminalRow>();

  for (const row of due.results) {
    if (!budget.take(1, { reserved: true })) break;
    const card = await buildCard(env.DB, row.queue_id, row.archetype, row.terminal_status, row.fallback_text);
    let messageId: number | null = null;
    try {
      const sent = await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, card.text, { buttons: card.buttons });
      messageId = sent.message_id;
    } catch (e) {
      // No cards row -> retried next tick. Logged so a persistent failure
      // is visible in the tail rather than an eternal silent retry.
      log("error", "card delivery failed; will retry", { queueId: row.queue_id, error: String(e) });
      continue;
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO cards (queue_id, telegram_message_id, delivered_at) VALUES (?1, ?2, ?3)`,
    )
      .bind(row.queue_id, messageId, iso(now))
      .run();
    log("info", "card delivered", { queueId: row.queue_id, held: card.held });
  }
}
