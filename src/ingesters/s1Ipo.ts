import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_LOG_ONLY } from "../lib/db";
import { formFeedUrl, parseEdgarFormFeed, type EdgarFormEntry } from "./edgarForms";
import { iso } from "../lib/time";
import { log } from "../lib/log";

/**
 * p5-30: the IPO / S-1 lane, with amendment tracking.
 *
 * THE EDITORIAL FACT is not "a company filed an S-1". It is how many times the
 * deal has been revised before it priced. An S-1 followed by six amendments is
 * a company that kept having to restate its own offering, and the amendment
 * COUNT is a parsed fact we can hold, not a characterisation.
 *
 * Three forms, three different moments in one deal:
 *   S-1     the registration itself. The deal becomes public.
 *   S-1/A   an amendment. The interesting one, and only in aggregate.
 *   424B4   the final prospectus. The deal actually priced.
 *
 * INGESTED AT LOG-ONLY, DELIBERATELY, FOR NOW. There is no IPO_FILING
 * archetype and no exemplar bank for one, and the exemplar gate refuses
 * generation outright when a bank is empty — which produces a template card
 * with no voice, the exact defect B-07/B-08 spent a whole block removing
 * (four cards sat at `skipped_no_exemplar` for weeks). Scoring these postable
 * before the archetype exists would manufacture that failure on purpose.
 *
 * So this chunk lands the ingest and the amendment counter; the archetype and
 * its exemplars are the follow-on that turns carding on. The lake starts
 * filling now, which is what the counter needs anyway: amendment depth is only
 * knowable once we have seen the earlier filings.
 *
 * FEEDS LIVE-VERIFIED 2026-08-07, all 200 `application/atom+xml`:
 *   S-1 31 entries · S-1/A 11 · 424B4 10
 */

export const SOURCE = "sec_s1";

export const S1_FORMS: readonly string[] = ["S-1", "S-1/A", "424B4"];

/** Per-run insert cap across all three forms. */
export const MAX_S1_PER_RUN = 40;

export type DealStage = "registration" | "amendment" | "priced";

export function stageOf(formType: string): DealStage {
  const f = formType.toUpperCase();
  if (f.startsWith("424B")) return "priced";
  if (f.includes("/A")) return "amendment";
  return "registration";
}

/**
 * How many S-1 amendments this issuer has already filed, from OUR OWN LAKE.
 *
 * Counted rather than asserted: the number is only as good as what we have
 * actually seen, so a lane that has been running two days must not imply it
 * knows a deal's full history. Callers get the count AND the earliest filing
 * we hold, so copy can say "at least N since <date>" instead of a bare figure
 * that reads as complete.
 */
export async function amendmentHistory(
  db: D1Database,
  cik: string,
): Promise<{ amendments: number; firstSeenIso: string | null }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(event_at) AS first_seen
         FROM items
        WHERE source = ?1
          AND json_extract(payload, '$.cik') = ?2
          AND json_extract(payload, '$.stage') = 'amendment'`,
    )
    .bind(SOURCE, cik)
    .first<{ n: number; first_seen: string | null }>();
  return { amendments: row?.n ?? 0, firstSeenIso: row?.first_seen ?? null };
}

export function factLineFor(e: EdgarFormEntry, stage: DealStage, amendments: number): string {
  if (stage === "priced") return `${e.company} filed a final prospectus (424B4), per SEC`;
  if (stage === "amendment") {
    // "at least" because the count is what WE have seen, not EDGAR's total.
    const n = amendments + 1;
    return `${e.company} amended its S-1 registration, at least ${n} amendments on record, per SEC`;
  }
  return `${e.company} filed an S-1 registration statement, per SEC`;
}

export async function pollS1(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<number> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);
  let inserted = 0;
  try {
    for (const form of S1_FORMS) {
      if (!budget.take(1)) {
        log("warn", "tick budget exhausted mid-s1 poll", { source: SOURCE, form });
        break;
      }
      const res = await politeFetch(formFeedUrl(form), {
        userAgent: buildUserAgent(env.CONTACT_EMAIL),
        timeoutMs: 20_000,
      });
      if (!res.ok) throw new Error(`${SOURCE} ${form} ${res.status}`);
      const entries = parseEdgarFormFeed(res.body);
      if (entries.length === 0) {
        // A 200 with zero parseable entries is a SHAPE CHANGE, not a quiet
        // day: EDGAR always has recent filings of these types.
        throw new Error(`${SOURCE} ${form}: 200 but zero parseable entries`);
      }
      for (const e of entries.slice(0, MAX_S1_PER_RUN)) {
        const stage = stageOf(e.formType);
        const { amendments, firstSeenIso } = await amendmentHistory(env.DB, e.cik);
        const result = await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: e.accession,
            category: "ipo_registration",
            eventAt: e.filedIso,
            sourceUrl: e.indexUrl,
            payload: {
              formType: e.formType,
              company: e.company,
              cik: e.cik,
              stage,
              accession: e.accession,
              priorAmendments: amendments,
              amendmentsSinceIso: firstSeenIso,
              factLine: factLineFor(e, stage, amendments),
            },
            // LOG-ONLY until an IPO archetype and its exemplars exist. See the
            // header: scoring postable now would produce a voiceless template
            // card, which is the defect B-08 removed rather than one to add.
            score: SCORE_LOG_ONLY,
            status: "logged",
          },
          now,
        );
        if (result.outcome === "inserted") inserted += 1;
      }
    }
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    await putSourceState(env.DB, state);
    if (inserted > 0) log("info", "s1 lane", { source: SOURCE, inserted });
    return inserted;
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    await recordSourceError(env.DB, SOURCE, e, now).catch(() => {});
    log("error", "s1 poll failed", { source: SOURCE, error: String(e) });
    return inserted;
  }
}

export function s1Job() {
  return (env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> =>
    pollS1(env, now, budget).then(() => undefined);
}
