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
 * How many S-1 amendments each issuer has already filed, from OUR OWN LAKE.
 *
 * BATCHED, and that is not a micro-optimisation (D-82). The first version ran
 * one query per entry inside the insert loop, so a 31-entry S-1 feed meant 31
 * sequential D1 round trips on top of three feed fetches — and the live run
 * proved it: `sec_s1` recorded `TimeoutError: The operation was aborted` on
 * its very first production poll, after inserting the S-1 batch but before
 * finishing the remaining forms. The lane half-worked, which is worse than
 * failing, because the source row still showed rows arriving.
 *
 * Counted rather than asserted: the number is only as good as what we have
 * actually seen, so callers get the count AND the earliest filing we hold, and
 * copy says "at least N" instead of a bare figure that reads as complete.
 */
export async function amendmentHistoryFor(
  db: D1Database,
  ciks: readonly string[],
): Promise<Map<string, { amendments: number; firstSeenIso: string | null }>> {
  const out = new Map<string, { amendments: number; firstSeenIso: string | null }>();
  const unique = [...new Set(ciks)].filter(Boolean);
  if (unique.length === 0) return out;
  // One statement, one round trip. The IN list is built from placeholders
  // rather than interpolation, so a CIK can never reach SQL as text.
  //
  // POSITIONAL `?`, not numbered `?1`/`?2`. The numbered form returned zero
  // rows for a multi-value IN list under D1 while working for a single value,
  // which is the worst way for it to fail: the single-CIK path kept passing
  // and only the batch was silently empty.
  const placeholders = unique.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT json_extract(payload, '$.cik') AS cik,
              COUNT(*) AS n,
              MIN(event_at) AS first_seen
         FROM items
        WHERE source = ?
          AND json_extract(payload, '$.stage') = 'amendment'
          AND json_extract(payload, '$.cik') IN (${placeholders})
        GROUP BY json_extract(payload, '$.cik')`,
    )
    .bind(SOURCE, ...unique)
    .all<{ cik: string; n: number; first_seen: string | null }>();
  for (const r of rows.results) out.set(r.cik, { amendments: r.n, firstSeenIso: r.first_seen });
  // An issuer with no amendments yet is ABSENT from the GROUP BY, not zero, so
  // fill it in rather than letting the caller read `undefined` as a count.
  for (const cik of unique) if (!out.has(cik)) out.set(cik, { amendments: 0, firstSeenIso: null });
  return out;
}

/** Single-CIK convenience, on top of the batched query. */
export async function amendmentHistory(
  db: D1Database,
  cik: string,
): Promise<{ amendments: number; firstSeenIso: string | null }> {
  return (await amendmentHistoryFor(db, [cik])).get(cik) ?? { amendments: 0, firstSeenIso: null };
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
      const batch = entries.slice(0, MAX_S1_PER_RUN);
      // ONE query for the whole batch, before the insert loop (D-82).
      const history = await amendmentHistoryFor(env.DB, batch.map((e) => e.cik));
      for (const e of batch) {
        const stage = stageOf(e.formType);
        const { amendments, firstSeenIso } = history.get(e.cik) ?? { amendments: 0, firstSeenIso: null };
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
