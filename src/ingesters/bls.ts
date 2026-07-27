import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { ET, iso, zonedTimeToUtc } from "../lib/time";
import { log } from "../lib/log";

// BLS scheduled releases (live-verified 2026-07-26; fixtures captured
// 2026-07-27T05:24Z). bls.ics is the machine-readable calendar (ETag
// served; DTSTART;TZID=US-Eastern). Release pages serve NO cache headers —
// detection is a content-diff on the USDL number. Flat files are unusable
// in the hot path (48MB, Range ignored). Identifying UA is MANDATORY
// (default UAs get 403).
export const BLS_ICS = "https://www.bls.gov/schedule/news_release/bls.ics";
export const SOURCE = "bls";

export const RELEASES: Record<string, { slug: string; label: string }> = {
  "Consumer Price Index": { slug: "cpi", label: "CPI" },
  "Employment Situation": { slug: "empsit", label: "Employment Situation (jobs report)" },
  "Job Openings and Labor Turnover Survey": { slug: "jolts", label: "JOLTS" },
};

export function releaseUrl(slug: string): string {
  return `https://www.bls.gov/news.release/${slug}.nr0.htm`;
}

// ---------------------------------------------------------------------------
// Calendar sync (daily): bls.ics -> release_calendar rows.

export interface IcsEvent {
  summary: string;
  scheduledUtcIso: string;
}

export function parseBlsIcs(ics: string): IcsEvent[] {
  // Unfold RFC 5545 continuation lines, then walk VEVENTs.
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const out: IcsEvent[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0] ?? "";
    const summary = /SUMMARY:(.+)/.exec(body)?.[1]?.trim();
    const dt = /DTSTART;TZID=US-Eastern:(\d{8})T(\d{6})/.exec(body);
    if (!summary || !dt) continue;
    const d = dt[1]!;
    const t = dt[2]!;
    const utc = zonedTimeToUtc(
      ET,
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)),
      Number(d.slice(6, 8)),
      Number(t.slice(0, 2)),
      Number(t.slice(2, 4)),
      Number(t.slice(4, 6)),
    );
    out.push({ summary, scheduledUtcIso: utc.toISOString() });
  }
  return out;
}

async function armWatcher(env: Env, now: Date): Promise<void> {
  const next = await env.DB.prepare(
    `SELECT MIN(scheduled_at) AS next FROM release_calendar
     WHERE source = ?1 AND fired_at IS NULL AND armed = 0 AND scheduled_at > ?2`,
  )
    .bind(SOURCE, iso(now))
    .first<{ next: string | null }>();
  // Wake 90s early for the pre-release wait; fall back to a 6h heartbeat.
  const due = next?.next
    ? new Date(Math.max(new Date(next.next).getTime() - 90_000, now.getTime() + 30_000))
    : new Date(now.getTime() + 6 * 3_600_000);
  await env.DB.prepare(`UPDATE jobs SET due_at = ?1 WHERE name = 'bls_watch'`).bind(iso(due)).run();
}

export async function syncBlsCalendar(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const state = await getSourceState(env.DB, "bls_calendar");
  state.lastPolledAt = iso(now);
  if (!budget.take(1)) return;

  let res;
  try {
    res = await politeFetch(BLS_ICS, {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
      validators: { etag: state.etag, lastModified: state.lastModified },
    });
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state);
    log("warn", "bls calendar fetch failed", { error: String(e), failures: state.consecutiveFailures });
    return;
  }

  try {
    if (!res.notModified) {
      if (!res.ok) {
        state.consecutiveFailures += 1;
        await putSourceState(env.DB, state);
        log("warn", "bls calendar non-2xx", { status: res.status });
        return;
      }
      const events = parseBlsIcs(res.body).filter((e) => RELEASES[e.summary]);
      if (events.length === 0) {
        state.consecutiveFailures += 1;
        await putSourceState(env.DB, state);
        log("warn", "bls calendar parsed to zero tracked events; possible shape drift");
        return;
      }
      for (const event of events) {
        if (new Date(event.scheduledUtcIso).getTime() < now.getTime() - 86_400_000) continue;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO release_calendar (source, release_name, scheduled_at) VALUES (?1, ?2, ?3)`,
        )
          .bind(SOURCE, event.summary, event.scheduledUtcIso)
          .run();
      }
      state.etag = res.etag;
      state.lastModified = res.lastModified;
    }
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);
    await armWatcher(env, now);
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    log("error", "bls calendar sync failed", { error: String(e) });
  }
}

// ---------------------------------------------------------------------------
// Release parsing (CPI gets full numbers; others get release-alerts).

export interface CpiHeadline {
  usdl: string;
  refMonth: string; // "JUNE 2026" as printed
  momVerb: string | null; // increased | decreased | was unchanged...
  momPct: number | null;
  priorVerb: string | null;
  priorPct: number | null;
  yoyVerb: string | null;
  yoyPct: number | null;
  coreVerb: string | null;
  corePct: number | null;
}

const USDL_RE = /USDL-(\d{2}-\d{4})/;

export function parseCpiRelease(html: string): CpiHeadline | null {
  const usdl = USDL_RE.exec(html)?.[1];
  const refMonth = /CONSUMER PRICE INDEX\s*[-–—]\s*([A-Z]+ \d{4})/.exec(html)?.[1];
  if (!usdl || !refMonth) return null;

  // ONE regex per claim, anchored to the all-items sentence: the release
  // contains several "after <verb> N.N percent in <Month>" clauses for
  // component indexes (energy, food...), and an unanchored prior-month match
  // would publish a component's move as CPI's. Prose wraps at ~110 chars, so
  // every inter-word gap is \s+.
  const mom =
    /\(CPI-U\)\s+(rose|increased|decreased|fell|declined|was\s+unchanged)(?:\s+(\d+\.\d+)\s+percent)?\s+on\s+a\s+seasonally\s+adjusted\s+basis\s+in\s+[A-Z][a-z]+\s*,?\s*(?:after\s+(rising|increasing|falling|decreasing|declining|being\s+unchanged|remaining\s+unchanged)(?:\s+(\d+\.\d+)\s+percent)?\s+in\s+[A-Z][a-z]+)?/.exec(
      html,
    );
  const yoy =
    /Over\s+the\s+last\s+12\s+months,\s+the\s+all\s+items\s+index\s+(rose|increased|decreased|fell|declined|was\s+unchanged)(?:\s+(\d+\.\d+)\s+percent)?/.exec(
      html,
    );
  const core =
    /index\s+for\s+all\s+items\s+less\s+food\s+and\s+energy\s+(rose|increased|decreased|fell|declined|was\s+unchanged)(?:\s+(\d+\.\d+)\s+percent)?\s+in/.exec(
      html,
    );

  const norm = (v: string | undefined): string | null => (v ? v.replace(/\s+/g, " ") : null);
  return {
    usdl,
    refMonth,
    momVerb: norm(mom?.[1]),
    momPct: mom?.[2] ? Number(mom[2]) : null,
    priorVerb: norm(mom?.[3]),
    priorPct: mom?.[4] ? Number(mom[4]) : null,
    yoyVerb: norm(yoy?.[1]),
    yoyPct: yoy?.[2] ? Number(yoy[2]) : null,
    coreVerb: norm(core?.[1]),
    corePct: core?.[2] ? Number(core[2]) : null,
  };
}

/**
 * Direction from the release's own verb, by STEM — the prose mixes tenses
 * ("decreased" / "declining" / "falling"). An unrecognized verb yields null
 * rather than a defaulted sign: a fabricated direction on a market-moving
 * number is worse than saying nothing.
 */
function signed(verb: string | null, pct: number | null): string | null {
  if (!verb) return null;
  const v = verb.toLowerCase();
  if (v.includes("unchanged")) return "unchanged";
  if (pct === null) return null; // a verb without its number is never claimed
  const neg = /decreas|fell|fall|declin|drop/.test(v);
  const pos = /rose|ris|increas|climb|advanc/.test(v);
  if (!neg && !pos) {
    log("warn", "unrecognized bls direction verb; omitting the figure", { verb });
    return null;
  }
  return `${neg ? "-" : "+"}${pct}%`;
}

/** Tier A: every number parsed; pieces that didn't parse are simply absent. */
export function draftCpi(h: CpiHeadline): string {
  const parts: string[] = [];
  const mom = signed(h.momVerb, h.momPct);
  const prior = signed(h.priorVerb, h.priorPct);
  const core = signed(h.coreVerb, h.corePct);
  if (mom) parts.push(`CPI ${mom} m/m`);
  if (prior) parts.push(`prior ${prior}`);
  if (core) parts.push(`core ${core}`);
  const yoy = signed(h.yoyVerb, h.yoyPct);
  if (yoy) parts.push(`${yoy === "unchanged" ? "unchanged" : yoy} y/y`);
  const numbers = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  const month = h.refMonth.charAt(0) + h.refMonth.slice(1).toLowerCase();
  return `BLS: Consumer Price Index, ${month}${numbers} (USDL-${h.usdl})`;
}

// ---------------------------------------------------------------------------
// The watcher: waits for the scheduled second, tight-polls, posts the print.

export async function watchBls(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> {
  const windowStart = iso(new Date(now.getTime() - 600_000));
  const windowEnd = iso(new Date(now.getTime() + 120_000));
  const release = await env.DB.prepare(
    `SELECT id, release_name, scheduled_at FROM release_calendar
     WHERE source = ?1 AND fired_at IS NULL AND armed = 0
       AND scheduled_at > ?2 AND scheduled_at <= ?3
     ORDER BY scheduled_at LIMIT 1`,
  )
    .bind(SOURCE, windowStart, windowEnd)
    .first<{ id: number; release_name: string; scheduled_at: string }>();

  if (!release) {
    await armWatcher(env, now);
    return;
  }
  const meta = RELEASES[release.release_name];
  if (!meta) {
    await env.DB.prepare(`UPDATE release_calendar SET armed = 1 WHERE id = ?1`).bind(release.id).run();
    return;
  }

  const userAgent = buildUserAgent(env.CONTACT_EMAIL);
  const stateKey = `bls_${meta.slug}`;
  const state = await getSourceState(env.DB, stateKey);
  state.lastPolledAt = iso(now);

  const intervalMs = Math.max(0, Number(env.BLS_POLL_INTERVAL_MS ?? 2500)) || 0;
  const deadlineMs = Math.max(1, Number(env.BLS_POLL_DEADLINE_MS ?? 90_000));
  // Hard poll cap: without it a tight loop could drain the whole shared tick
  // budget (40) and starve the ingesters sharing this invocation. 20 polls
  // at the default interval covers ~50s, which is where BLS detection is
  // actually won; a miss beyond that is a real anomaly worth logging.
  const maxPolls = 20;

  // Wait out the gap to the scheduled second (cron granularity is 1 min).
  const waitMs = new Date(release.scheduled_at).getTime() - now.getTime();
  if (waitMs > 0 && waitMs < 150_000) await new Promise((r) => setTimeout(r, waitMs));

  const started = Date.now();
  let detected = false;
  let ranOutOfBudget = false;
  let polls = 0;
  while (Date.now() - started <= deadlineMs && polls < maxPolls) {
    polls += 1;
    if (!budget.take(1)) {
      log("warn", "tick budget exhausted mid bls watch; deferring to next tick");
      ranOutOfBudget = true;
      break;
    }
    let page;
    try {
      page = await politeFetch(releaseUrl(meta.slug), { userAgent, timeoutMs: 10_000 });
    } catch (e) {
      log("warn", "bls release poll threw", { slug: meta.slug, error: String(e) });
      page = null;
    }
    if (page?.ok) {
      const usdl = USDL_RE.exec(page.body)?.[1] ?? null;
      if (usdl && state.cursor === null) {
        // FIRST EVER poll for this release: the page still holds the PREVIOUS
        // print. Prime the cursor and keep watching for the flip — posting
        // this would publish last month's numbers as today's news.
        state.cursor = usdl;
        await putSourceState(env.DB, state);
        log("info", "bls cursor primed from pre-release page", { slug: meta.slug, usdl });
      } else if (usdl && usdl !== state.cursor) {
        // NEW RELEASE. CPI gets the full parsed print; others an alert.
        let draft: string;
        let macroPayload: Record<string, unknown> = { slug: meta.slug, usdl, releaseName: release.release_name };
        if (meta.slug === "cpi") {
          // Parse ONCE (10ms CPU budget) and carry SIGNED values: gating on
          // magnitudes would let core -0.6 read as "above" headline +0.5.
          const headline = parseCpiRelease(page.body);
          draft = headline ? draftCpi(headline) : `BLS: Consumer Price Index released (USDL-${usdl})`;
          const sign = (verb: string | null, pct: number | null): number | null => {
            if (verb === null || pct === null) return null;
            if (verb.toLowerCase().includes("unchanged")) return 0;
            return /decreas|fell|fall|declin|drop/.test(verb.toLowerCase()) ? -pct : pct;
          };
          macroPayload = {
            ...macroPayload,
            refMonth: headline?.refMonth ?? null,
            momText: headline ? draft.split(": ").slice(2).join(": ") || null : null,
            momSigned: sign(headline?.momVerb ?? null, headline?.momPct ?? null),
            coreSigned: sign(headline?.coreVerb ?? null, headline?.corePct ?? null),
            yoyPct: headline?.yoyPct ?? null,
            partialParse: headline ? headline.momPct === null || headline.yoyPct === null : true,
          };
        } else {
          const month = /[A-Z]{2,}[A-Z ]*\s*[-–—]+\s*([A-Z]+ \d{4})/.exec(page.body)?.[1];
          draft = `BLS: ${meta.label}${month ? `, ${month.charAt(0) + month.slice(1).toLowerCase()}` : ""} released (USDL-${usdl})`;
        }
        macroPayload = { ...macroPayload, factLine: draft };
        const item = await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: `${meta.slug}:${usdl}`,
            category: "macro_print",
            eventAt: release.scheduled_at,
            sourceUrl: releaseUrl(meta.slug),
            payload: macroPayload,
            score: SCORE_AUTO_ALERT,
            status: "new",
          },
          now,
        );
        if (item.outcome === "inserted" && item.id !== null && budget.take(1)) {
          // Speed path: notify immediately rather than waiting for a drain.
          await enqueueForApproval(env, item.id, "MACRO_PRINT", macroPayload, releaseUrl(meta.slug), now);
        }
        await env.DB.prepare(`UPDATE release_calendar SET fired_at = ?1, armed = 1 WHERE id = ?2`)
          .bind(iso(now), release.id)
          .run();
        state.cursor = usdl;
        detected = true;
        log("info", "bls release detected", { slug: meta.slug, usdl, elapsedMs: Date.now() - started });
        break;
      }
    }
    if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (!detected && !ranOutOfBudget) {
    // Polled to the deadline with no USDL flip: give up LOUDLY and mark the
    // window handled so a stale schedule can't silently re-trigger. (A
    // budget-truncated run leaves it unarmed for the next tick instead.)
    await env.DB.prepare(`UPDATE release_calendar SET armed = 1 WHERE id = ?1`).bind(release.id).run();
    log("error", "bls release NOT detected", { slug: meta.slug, scheduled: release.scheduled_at, polls, elapsedMs: Date.now() - started });
  }

  state.consecutiveFailures = detected ? 0 : state.consecutiveFailures;
  state.lastOkAt = detected ? iso(now) : state.lastOkAt;
  await putSourceState(env.DB, state);

  if (ranOutOfBudget && !detected) {
    // Do NOT hand the watcher to armWatcher here: that query skips this
    // still-unfired release (scheduled_at <= now), silently jumping to the
    // next month's. Retry this one on the very next tick instead.
    await env.DB.prepare(`UPDATE jobs SET due_at = ?1 WHERE name = 'bls_watch'`)
      .bind(iso(new Date(Date.now() + 30_000)))
      .run();
    log("error", "bls watch truncated by tick budget; retrying same release", {
      slug: meta.slug,
      scheduled: release.scheduled_at,
    });
    return;
  }
  await armWatcher(env, now);
}
