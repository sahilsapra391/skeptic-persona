import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { getSourceState, insertItem, putSourceState, recordSourceError, SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../lib/db";
import { enqueueForApproval } from "../pipeline/enqueue";
import { iso } from "../lib/time";
import { log } from "../lib/log";

// NOAA National Hurricane Center — active tropical cyclones.
// Live-verified 2026-07-28T04:58Z: 200, 9,236 bytes, two active storms
// (Hurricane Genevieve 125 kt / 939 mb, TS Fausto 60 kt).
//
// WHY A MARKET WIRE CARRIES WEATHER: Atlantic hurricanes move Gulf energy
// infrastructure and insurer exposure. Eastern Pacific storms almost never
// do, which is the whole editorial gate below.
export const NHC_CURRENT_STORMS = "https://www.nhc.noaa.gov/CurrentStorms.json";
export const NHC_PAGE = "https://www.nhc.noaa.gov/";

export const SOURCE = "noaa_storms";

/** Sustained winds (knots) at which a storm is a major hurricane (Cat 3+). */
export const MAJOR_HURRICANE_KT = 96;

export interface Storm {
  id: string;
  name: string;
  /** NHC's own code: HU hurricane, TS tropical storm, TD depression, PTC. */
  classification: string;
  /** Sustained winds in knots. */
  intensityKt: number | null;
  pressureMb: number | null;
  /** "al" Atlantic, "ep" eastern Pacific, "cp" central Pacific. */
  basin: string;
  movementDir: number | null;
  movementSpeedKt: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

export function parseStorms(body: string): Storm[] {
  const d = JSON.parse(body) as { activeStorms?: Array<Record<string, unknown>> };
  const out: Storm[] = [];
  for (const s of d.activeStorms ?? []) {
    const id = String(s.id ?? "").trim().toLowerCase();
    const name = String(s.name ?? "").trim();
    if (!id || !name) continue;
    out.push({
      id,
      name,
      classification: String(s.classification ?? "").trim(),
      intensityKt: num(s.intensity),
      pressureMb: num(s.pressure),
      // The basin is the first two characters of NHC's own storm id.
      basin: id.slice(0, 2),
      movementDir: num(s.movementDir),
      movementSpeedKt: num(s.movementSpeed),
    });
  }
  return out;
}

/**
 * EDITORIAL GATE, and it is the whole reason this source is defensible on a
 * market wire: only ATLANTIC hurricanes. Gulf energy infrastructure and
 * insurer exposure sit in the Atlantic basin; an eastern Pacific storm is
 * weather, not market news, however severe. Both storms live at verification
 * time were `ep` and correctly produced nothing.
 */
export function scoreStorm(s: Storm): number {
  if (s.basin !== "al") return SCORE_LOG_ONLY;
  if (s.classification !== "HU") return SCORE_LOG_ONLY;
  if (s.intensityKt === null) return SCORE_LOG_ONLY;
  return s.intensityKt >= MAJOR_HURRICANE_KT ? SCORE_AUTO_ALERT : SCORE_POSTABLE;
}

/** Tier A: NHC's own fields, in NHC's own units. */
export function draftStorm(s: Storm): string {
  const parts: string[] = [];
  if (s.intensityKt !== null) parts.push(`${s.intensityKt} kt sustained`);
  if (s.pressureMb !== null) parts.push(`${s.pressureMb} mb`);
  const detail = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  return `Atlantic hurricane ${s.name}${detail}, per the National Hurricane Center`;
}

export async function pollNoaaStorms(
  env: Env,
  now: Date = new Date(),
  budget: TickBudget = newTickBudget(),
): Promise<void> {
  if (!budget.take(1)) return;
  const state = await getSourceState(env.DB, SOURCE);
  try {
    const res = await politeFetch(NHC_CURRENT_STORMS, {
      userAgent: buildUserAgent(env.CONTACT_EMAIL),
      timeoutMs: 20_000,
    });
    if (!res.ok) throw new Error(`nhc ${res.status}`);
    const storms = parseStorms(res.body);
    // An EMPTY list is normal and correct out of season. It is not a parse
    // failure, and treating it as one would alarm for nine months a year.
    for (const s of storms) {
      const score = scoreStorm(s);
      // Advisories update ~every 6h and intensity changes; the dedup key
      // carries the intensity so a strengthening storm is a new item and a
      // restated one is not.
      await insertItem(
        env.DB,
        {
          source: SOURCE,
          externalId: `${s.id}:${s.classification}:${s.intensityKt ?? "?"}`,
          category: "weather",
          eventAt: iso(now),
          sourceUrl: NHC_PAGE,
          payload: { ...s, isAtlanticHurricane: score >= SCORE_POSTABLE, factLine: draftStorm(s) },
          score,
          status: score >= SCORE_POSTABLE ? "new" : "logged",
        },
        now,
      );
    }
    state.consecutiveFailures = 0;
    state.lastOkAt = iso(now);
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastPolledAt = iso(now);
    await putSourceState(env.DB, state);
    await recordSourceError(env.DB, SOURCE, e, now);
    log("error", "noaa storms poll failed", { error: String(e) });
    return;
  }

  const pending = await env.DB.prepare(
    `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' AND score >= ?2 ORDER BY id LIMIT 2`,
  )
    .bind(SOURCE, SCORE_POSTABLE)
    .all<{ id: number; source_url: string; payload: string }>();
  for (const row of pending.results) {
    if (!budget.take(1)) break;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const result = await enqueueForApproval(env, row.id, "STORM", payload, row.source_url, now);
    if (result.retryAfter !== null) break;
  }
}
