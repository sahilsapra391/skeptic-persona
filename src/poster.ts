import type { Env } from "./env";
import { newTickBudget, type TickBudget } from "./lib/budget";
import { getThreadsAuth, getPublishingQuota, KV_TOKEN_ALERTED, publishTextPost, refreshLongLived, storeThreadsAuth, ThreadsError } from "./lib/threads";
import { editMessageText, sendMessage } from "./lib/telegram";
import { checkRegister } from "./templates/validate";
import type { ArchetypeId } from "./templates/types";
import { iso } from "./lib/time";
import { log } from "./lib/log";

// The poster: drains APPROVED queue entries to Threads. Human-gated end to
// end in P2 — nothing posts that Sahil didn't approve (or edit) in Telegram,
// and POSTING_ENABLED must be "true" on top of that. What was approved is
// exactly what posts (edited_text wins over draft_text); the source link
// rides in link_attachment per the every-post-carries-its-source rule.

export const MAX_POSTS_PER_RUN = 3;

function dailyCap(env: Env): number {
  const n = Number(env.POST_DAILY_CAP ?? 25);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

interface ApprovedRow {
  queue_id: number;
  item_id: number;
  archetype: string;
  text: string;
  source_url: string;
  category: string;
  telegram_message_id: number | null;
}

export async function runPoster(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  if (env.POSTING_ENABLED !== "true") return; // master gate (wrangler.toml var)

  const auth = await getThreadsAuth(env.KV);
  if (!auth) return; // not onboarded yet; queue keeps accumulating approvals

  // Editorial daily cap (our own budget, far under the platform's 250/24h).
  const since = iso(new Date(now.getTime() - 24 * 3_600_000));
  const posted24h =
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM post_log WHERE posted_at > ?1`).bind(since).first<{ n: number }>())
      ?.n ?? 0;
  if (posted24h >= dailyCap(env)) {
    log("warn", "editorial daily post cap reached; holding approved posts", { posted24h, cap: dailyCap(env) });
    return;
  }

  // A claim with no post id, older than a few minutes, means a publish
  // survived but its confirmation didn't — visible, never silent.
  const orphans = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM post_log WHERE platform_post_id IS NULL AND posted_at < ?1`,
  )
    .bind(iso(new Date(now.getTime() - 300_000)))
    .first<{ n: number }>();
  if ((orphans?.n ?? 0) > 0) {
    log("error", "unconfirmed post claims present (published but id not recorded)", { count: orphans?.n });
  }

  const rows = await env.DB.prepare(
    `SELECT q.id AS queue_id, q.item_id, q.archetype,
            COALESCE(q.edited_text, q.draft_text) AS text,
            q.telegram_message_id,
            i.source_url, i.category
     FROM queue q
     JOIN items i ON i.id = q.item_id
     LEFT JOIN post_log p ON p.queue_id = q.id
     WHERE q.state IN ('approved', 'edited') AND p.id IS NULL
       AND i.source <> 'smoke_test'
     ORDER BY q.decided_at
     LIMIT ?1`,
  )
    .bind(Math.min(MAX_POSTS_PER_RUN, dailyCap(env) - posted24h))
    .all<ApprovedRow>();
  if (rows.results.length === 0) return;

  // Platform quota guard (the docs instruct enforcing it client-side).
  if (!budget.take(1)) return;
  try {
    const quota = await getPublishingQuota(auth.token, auth.userId);
    if (quota && quota.used >= quota.total - 2) {
      log("error", "threads publishing quota nearly exhausted; holding posts", { ...quota });
      return;
    }
  } catch (e) {
    if (e instanceof ThreadsError && e.isTokenInvalid) {
      await alertTokenInvalid(env);
      return;
    }
    log("warn", "quota check failed; proceeding cautiously", { error: String(e) });
  }

  for (const row of rows.results) {
    if (!budget.take(1)) break;

    // LAST GATE BEFORE THE WORLD. The engine guarantees doctrine for text it
    // rendered, but `edited_text` is hand-typed and bypasses it entirely —
    // and an edit made before the edit-time validation shipped (or while
    // posting was disabled) would otherwise sail straight through. A real
    // near-miss: an edit reply of "na" sat approved-and-ready in the queue.
    const issues = checkRegister(row.text, row.archetype as ArchetypeId);
    if (issues.length > 0) {
      log("error", "post blocked by register check", {
        queueId: row.queue_id,
        issues: issues.map((i) => i.rule).join(","),
      });
      await env.DB.prepare(`UPDATE queue SET state = 'rejected', decided_at = ?1 WHERE id = ?2 AND state IN ('approved','edited')`)
        .bind(iso(now), row.queue_id)
        .run()
        .catch(() => {});
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && budget.take(1)) {
        try {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `Blocked #${row.queue_id} before posting: ${issues.map((i) => i.detail).join("; ")}. Nothing was published.`,
          );
        } catch (e) {
          log("warn", "block alert failed", { queueId: row.queue_id, error: String(e) });
        }
      }
      continue;
    }

    // PRE-CLAIM before publishing. If the isolate dies between the publish
    // call and the id write, the claim row (platform_post_id NULL) still
    // excludes this queue row from the next run's selection — the one thing
    // that must never happen is posting the same approval twice in public.
    // UNIQUE(queue_id) makes the claim atomic.
    const claim = await env.DB
      .prepare(
        `INSERT OR IGNORE INTO post_log (queue_id, platform_post_id, posted_at, archetype, category)
         VALUES (?1, NULL, ?2, ?3, ?4)`,
      )
      .bind(row.queue_id, iso(now), row.archetype, row.category)
      .run();
    if (claim.meta.changes === 0) continue; // already claimed elsewhere

    // The publish is its own try/catch: ONLY a failed publish releases the
    // claim. Anything that goes wrong AFTER the post is public must leave
    // the claim standing, or the next run re-posts it.
    let post: { id: string };
    try {
      post = await publishTextPost(auth.token, auth.userId, row.text, row.source_url);
    } catch (e) {
      await env.DB.prepare(`DELETE FROM post_log WHERE queue_id = ?1 AND platform_post_id IS NULL`)
        .bind(row.queue_id)
        .run()
        .catch(() => {});
      if (e instanceof ThreadsError && e.isTokenInvalid) {
        await alertTokenInvalid(env);
        return; // no point continuing this run
      }
      log("error", "threads post failed", { queueId: row.queue_id, error: String(e) });
      continue;
    }

    // Post is PUBLIC from here on. Bookkeeping failures are logged, never
    // compensated by releasing the claim.
    try {
      await env.DB.batch([
        env.DB
          .prepare(`UPDATE post_log SET platform_post_id = ?1, posted_at = ?2 WHERE queue_id = ?3`)
          .bind(post.id, iso(now), row.queue_id),
        env.DB.prepare(`UPDATE items SET status = 'posted' WHERE id = ?1`).bind(row.item_id),
      ]);
      log("info", "posted to threads", { queueId: row.queue_id, postId: post.id });
    } catch (e) {
      log("error", "post published but confirmation failed; claim retained", {
        queueId: row.queue_id,
        postId: post.id,
        error: String(e),
      });
    }

    if (row.telegram_message_id && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && budget.take(1)) {
      try {
        await editMessageText(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          row.telegram_message_id,
          `📤 Posted to Threads\n\n${row.text}`,
        );
      } catch (e) {
        log("warn", "post badge failed", { queueId: row.queue_id, error: String(e) });
      }
    }
  }
}

async function alertTokenInvalid(env: Env): Promise<void> {
  log("error", "threads token invalid; manual re-auth required");
  if (await env.KV.get(KV_TOKEN_ALERTED)) return; // once, not every 5 minutes
  await env.KV.put(KV_TOKEN_ALERTED, "1", { expirationTtl: 6 * 3600 });
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        "⚠️ Threads token is invalid or expired. Posting is paused — re-run the OAuth flow (/threads/oauth/start) to reconnect.",
      );
    } catch (e) {
      log("warn", "token alert send failed", { error: String(e) });
    }
  }
}

/**
 * Weekly-ish refresh (daily job, refreshes when the last refresh is >7 days
 * old): long-lived tokens die at 60 days and DEAD tokens are unrecoverable,
 * so this job is load-bearing. Alerts when expiry is near and refreshes fail.
 */
export async function refreshThreadsToken(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const auth = await getThreadsAuth(env.KV);
  if (!auth) return;

  const refreshedAt = auth.refreshedAt ? new Date(auth.refreshedAt).getTime() : 0;
  const ageDays = (now.getTime() - refreshedAt) / 86_400_000;
  if (ageDays < 7) return;

  if (!budget.take(1)) return;
  try {
    const refreshed = await refreshLongLived(auth.token);
    await storeThreadsAuth(env.KV, {
      token: refreshed.access_token,
      userId: auth.userId,
      expiresInSeconds: refreshed.expires_in,
      now,
    });
    log("info", "threads token refreshed", { expiresInDays: Math.round(refreshed.expires_in / 86_400) });
  } catch (e) {
    const daysToExpiry = auth.expiresAt ? (new Date(auth.expiresAt).getTime() - now.getTime()) / 86_400_000 : null;
    log("error", "threads token refresh failed", { error: String(e), daysToExpiry });
    if (e instanceof ThreadsError && e.isTokenInvalid) {
      await alertTokenInvalid(env);
    } else if (daysToExpiry !== null && daysToExpiry < 7 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && budget.take(1)) {
      try {
        await sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          `⚠️ Threads token refresh keeps failing and the token expires in ~${Math.max(0, Math.round(daysToExpiry))} days. Re-run /threads/oauth/start before it dies (an expired token cannot be refreshed).`,
        );
      } catch (err) {
        log("warn", "refresh alert send failed", { error: String(err) });
      }
    }
  }
}
