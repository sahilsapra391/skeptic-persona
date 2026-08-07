import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_LOG_ONLY } from "../lib/db";
import { formFeedUrl, parseEdgarFormFeed, type EdgarFormEntry } from "./edgarForms";
import { SOURCE as SCHEDULE13_SOURCE } from "./schedule13d";
import { iso } from "../lib/time";
import { log } from "../lib/log";

/**
 * p5-31: the proxy-contest lane, cross-referenced against our own 13D lake.
 *
 * WHY THESE THREE FORMS AND NOT DEF 14A. Measured live 2026-08-07 on the same
 * minute, which is the whole argument:
 *
 *   DEF 14A   26 entries    the ordinary annual meeting. High volume, no story.
 *   DFAN14A    6 entries    additional soliciting material, either side.
 *   DEFC14A    1 entry      definitive CONTESTED solicitation.
 *   PREC14A    1 entry      preliminary CONTESTED solicitation.
 *
 * The `C` in DEFC14A/PREC14A is literally "contested". Those two are rare and
 * self-identifying, which is the ideal shape for this desk: low volume, high
 * salience, no judgement call required to know something is happening.
 *
 * THE CROSS-REFERENCE IS THE POINT (the plan says "13D cross-reference from
 * our lake", and we hold 1,448 Schedule 13D/G rows). An activist who filed a
 * 13D and is now soliciting proxies has escalated from "I own a stake" to "I
 * want your board", and both halves are parsed facts from our own data. That
 * is a juxtaposition, the move that cannot produce a false statement because
 * it contains no statement beyond the two facts.
 *
 * `(Filed by)` IS THE SIGNAL on these forms. It means the filing came from
 * someone other than the subject company. `edgar8k`'s title parser hard-codes
 * `(Filer)` and would have dropped exactly the filings this lane exists for,
 * which is why `edgarForms.ts` generalises the role.
 *
 * INGESTED AT LOG-ONLY FOR NOW, for the same reason as p5-30: there is no
 * PROXY_CONTEST archetype and no exemplar bank, and the gate refuses
 * generation when a bank is empty. Scoring these postable before the archetype
 * exists would manufacture the voiceless-template defect B-08 just removed.
 * The archetype and exemplars are the follow-on.
 */

export const SOURCE = "sec_proxy_contest";

/** DEF 14A is deliberately ABSENT: it is the routine annual meeting. */
export const CONTEST_FORMS: readonly string[] = ["DEFC14A", "PREC14A", "DFAN14A"];

export const MAX_CONTEST_PER_RUN = 25;

/** `DEFC14A`/`PREC14A` say "contested" on their face; DFAN14A does not. */
export function isSelfDeclaredContest(formType: string): boolean {
  const f = formType.toUpperCase().replace(/\s+/g, "");
  return f.startsWith("DEFC14A") || f.startsWith("PREC14A");
}

export interface StakeMatch {
  readonly matched: boolean;
  readonly issuerName: string | null;
  readonly percent: number | null;
  readonly dateOfEventIso: string | null;
}

/**
 * Has this filer already reported a 13D/G stake in our lake?
 *
 * Matched on CIK, never on name. A name match would be a guess dressed as a
 * join: "TOMS Capital Investment Management LP" appears in EDGAR under several
 * spellings, and the wrong pairing would attribute someone else's stake to
 * this solicitation, which is a fabrication with a citation attached.
 */
export async function priorStake(db: D1Database, filerCik: string): Promise<StakeMatch> {
  const row = await db
    .prepare(
      `SELECT payload FROM items
        WHERE source = ?1
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(payload, '$.persons')) p
             WHERE json_extract(p.value, '$.cik') = ?2
          )
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(SCHEDULE13_SOURCE, filerCik)
    .first<{ payload: string }>();
  if (!row) return { matched: false, issuerName: null, percent: null, dateOfEventIso: null };
  try {
    const p = JSON.parse(row.payload) as {
      issuerName?: string;
      topPercent?: number;
      dateOfEventIso?: string;
      persons?: Array<{ cik?: string; percentOfClass?: number }>;
    };
    // Prefer THIS filer's own percent over the filing's top holder: on a group
    // filing they are different people, and reporting the group's largest
    // stake as this filer's is exactly the kind of near-miss that reads as
    // sourced and is not.
    const mine = (p.persons ?? []).find((x) => x.cik === filerCik);
    const percent = typeof mine?.percentOfClass === "number" ? mine.percentOfClass : (p.topPercent ?? null);
    return {
      matched: true,
      issuerName: p.issuerName ?? null,
      percent: typeof percent === "number" ? percent : null,
      dateOfEventIso: p.dateOfEventIso ?? null,
    };
  } catch {
    // A payload that will not parse is NOT a match. Returning `matched: true`
    // with empty fields would let copy claim a stake it cannot describe.
    return { matched: false, issuerName: null, percent: null, dateOfEventIso: null };
  }
}

export function factLineFor(e: EdgarFormEntry, stake: StakeMatch): string {
  const kind = isSelfDeclaredContest(e.formType)
    ? `a contested proxy solicitation (${e.formType})`
    : `additional soliciting material (${e.formType})`;
  // Naming the TARGET is the whole reason the parser merges the pair: "TOMS
  // Capital filed X" is half a sentence, "regarding Voya Financial" is the
  // other half, and both come from the same accession.
  const against = e.subjectCompany ? ` regarding ${e.subjectCompany}` : "";
  const base = `${e.company} filed ${kind}${against}, per SEC`;
  if (!stake.matched || stake.percent === null || !stake.issuerName) return base;
  // The juxtaposition, and both halves are parsed fields from our own lake:
  // a stake disclosure, then a solicitation. No claim joins them.
  return `${base}. The same filer reported ${stake.percent}% of ${stake.issuerName} on a Schedule 13D`;
}

export async function pollProxyContest(env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<number> {
  const state = await getSourceState(env.DB, SOURCE);
  state.lastPolledAt = iso(now);
  let inserted = 0;
  try {
    for (const form of CONTEST_FORMS) {
      if (!budget.take(1)) {
        log("warn", "tick budget exhausted mid-proxy poll", { source: SOURCE, form });
        break;
      }
      const res = await politeFetch(formFeedUrl(form), {
        userAgent: buildUserAgent(env.CONTACT_EMAIL),
        timeoutMs: 20_000,
      });
      if (!res.ok) throw new Error(`${SOURCE} ${form} ${res.status}`);
      // ZERO ENTRIES IS NORMAL HERE, unlike the S-1 lane. Contested proxy
      // filings are genuinely rare (1 entry each for DEFC14A and PREC14A when
      // measured), so an empty feed is a quiet week, not a shape change.
      for (const e of parseEdgarFormFeed(res.body).slice(0, MAX_CONTEST_PER_RUN)) {
        const stake = await priorStake(env.DB, e.cik);
        const result = await insertItem(
          env.DB,
          {
            source: SOURCE,
            externalId: e.accession,
            category: "proxy_contest",
            eventAt: e.filedIso,
            sourceUrl: e.indexUrl,
            payload: {
              formType: e.formType,
              company: e.company,
              cik: e.cik,
              role: e.role,
              accession: e.accession,
              selfDeclaredContest: isSelfDeclaredContest(e.formType),
              priorStakeMatched: stake.matched,
              priorStakeIssuer: stake.issuerName,
              priorStakePercent: stake.percent,
              priorStakeDateIso: stake.dateOfEventIso,
              factLine: factLineFor(e, stake),
            },
            // LOG-ONLY until a PROXY_CONTEST archetype and exemplars exist.
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
    if (inserted > 0) log("info", "proxy contest lane", { source: SOURCE, inserted });
    return inserted;
  } catch (e) {
    state.consecutiveFailures += 1;
    await putSourceState(env.DB, state).catch(() => {});
    await recordSourceError(env.DB, SOURCE, e, now).catch(() => {});
    log("error", "proxy contest poll failed", { source: SOURCE, error: String(e) });
    return inserted;
  }
}

export function proxyContestJob() {
  return (env: Env, now: Date, budget: TickBudget = newTickBudget()): Promise<void> =>
    pollProxyContest(env, now, budget).then(() => undefined);
}
