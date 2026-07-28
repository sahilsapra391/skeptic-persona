import type { Env } from "../env";
import { newTickBudget, type TickBudget } from "../lib/budget";
import { buildUserAgent, politeFetch } from "../lib/http";
import { extractAll, extractFirst, stripBom } from "../lib/xml";
import { getSourceState, insertItem, putSourceState, SCORE_AUTO_ALERT, SCORE_LOG_ONLY ,
  recordSourceError,
} from "../lib/db";
import { recordFacts } from "../lookback";
import { enqueueForApproval } from "../pipeline/enqueue";
import { iso } from "../lib/time";
import { log } from "../lib/log";
import { RATE_ATTRIBUTION } from "./rateAttribution";

// Central-bank policy rates, as a DECLARATIVE family rather than one ingester
// per country. Every source here answers the same question — "what is the
// policy rate, and when did it last change" — so the only per-source code is
// a ~6-line parser. Adding a country is config.
//
// EDITORIAL RULE: a rate that did not move is not news. These series reprint
// the same number every business day; we post only on an observed CHANGE, and
// the first observation of a series establishes a baseline and posts nothing
// (we cannot claim a change we did not witness).
//
// All endpoints live-verified 2026-07-27T22:30Z — see docs/verification/.

export interface RateObservation {
  /** ISO date (YYYY-MM-DD) of the observation. */
  date: string;
  value: number;
}

export interface RateSource {
  /** items.source and the D1 job name. */
  id: string;
  country: string;
  /** What the number IS, in the issuer's own words where possible. */
  label: string;
  attribution: string;
  /** Static endpoint, or omit and supply buildUrl for a dated window. */
  url?: string;
  /** Endpoints that require a date range compute it at poll time. */
  buildUrl?: (now: Date) => string;
  /** Human-facing page carried as the post's source link. */
  sourceUrl: string;
  parse: (body: string) => RateObservation[];
  /**
   * The endpoint publishes ONLY the current level, with no history.
   *
   * detectChange needs two observations, so such a source could never post a
   * change and would log forever while looking healthy. For these, the prior
   * observation is the one WE recorded last poll (source_state.cursor), which
   * is a level we witnessed ourselves rather than one we inferred.
   *
   * OPT-IN PER SOURCE, deliberately. Applying the cursor fallback to a
   * history-bearing feed would resurrect old news: if the rate moved while we
   * were down and has been flat since, detectChange correctly returns null,
   * but the cursor still holds the pre-move level and would present a
   * days-old move as today's.
   */
  singleObservation?: true;
}

export function urlFor(src: RateSource, now: Date): string {
  return src.buildUrl ? src.buildUrl(now) : (src.url ?? "");
}

/** SNB's code for the policy rate (Leitzins) in its RSS-CB feed. */
export const SNB_POLICY_RATE_CODE = "SNBLZ";

const BOE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Bank of England's IADB wants DD/Mon/YYYY. */
export function boeDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${BOE_MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
}

/** "02 Jan 2026" -> ISO. The IADB CSV serves this format. */
export function boeDateToIso(v: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const mo = BOE_MONTHS.indexOf(m[2]!);
  if (mo < 0) return null;
  return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** DD/MM/YYYY -> ISO. Brazil's SGS serves this format. */
export function brDateToIso(v: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ---------------------------------------------------------------------------
// Sources. Each parser returns observations in ANY order; the caller sorts.

/**
 * RBA's F1 table identifies its columns by Series ID on a dedicated row.
 * FIRMMCRTD is the Cash Rate Target. Read the index from that row rather than
 * hardcoding it: the file carries 17 columns and their order is the RBA's to
 * change, but the Series ID is a published identifier.
 */
export const RBA_CASH_RATE_SERIES = "FIRMMCRTD";

const RBA_MONTHS: Readonly<Record<string, string>> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** RBA serves DD-Mon-YYYY ("27-Jul-2026"). */
export function rbaDateToIso(v: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const mm = RBA_MONTHS[m[2]!.toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}`;
}

/**
 * Parse the RBA F1 CSV into cash-rate observations.
 *
 * VERIFIED 2026-07-28: the file is 304KB of daily rows back to 2011, and the
 * NEWEST row carries an EMPTY cash-rate cell (the table is published before
 * the day's value is set). An empty cell must produce NO observation — never
 * a zero, which would read as a rate cut to 0%.
 */
export function parseRbaF1(body: string): RateObservation[] {
  const lines = stripBom(body).split(/\r?\n/);
  const header = lines.find((l) => l.startsWith("Series ID,"));
  if (!header) return [];
  const idx = header.split(",").indexOf(RBA_CASH_RATE_SERIES);
  if (idx < 1) return [];

  const out: RateObservation[] = [];
  for (const line of lines) {
    // Data rows start with the date; every metadata row starts with a label.
    if (!/^\d{1,2}-[A-Za-z]{3}-\d{4},/.test(line)) continue;
    const cells = line.split(",");
    const date = rbaDateToIso(cells[0] ?? "");
    const value = num(cells[idx]);
    if (date && value !== null) out.push({ date, value });
  }
  return out;
}

export const RATE_SOURCES: readonly RateSource[] = [
  {
    id: "rate_boi",
    country: "Israel",
    label: "Bank of Israel interest rate",
    attribution: RATE_ATTRIBUTION["Israel"]!,
    // 112 bytes of exact JSON, the cleanest rate endpoint in this file. It
    // carries NO history, only the current level, which is why the
    // single-observation capability exists.
    url: "https://www.boi.org.il/PublicApi/GetInterest",
    sourceUrl: "https://www.boi.org.il/en/economic-roles/monetary-policy/interest-rate/",
    singleObservation: true,
    parse: (body) => {
      const d = JSON.parse(body) as { currentInterest?: unknown; lastPublishedDate?: unknown };
      const value = num(d.currentInterest);
      // lastPublishedDate is when THIS level was published, so it dates the
      // observation. nextInterestDate is the next DECISION and is deliberately
      // ignored: a scheduled meeting is not a rate.
      const raw = typeof d.lastPublishedDate === "string" ? d.lastPublishedDate : "";
      const date = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
      return value !== null && date ? [{ date, value }] : [];
    },
  },
  {
    id: "rate_rba",
    country: "Australia",
    label: "Cash Rate Target",
    attribution: RATE_ATTRIBUTION["Australia"]!,
    // The F1 statistical table, which is the RBA's own machine-readable
    // publication of the series. 304KB and served with Last-Modified.
    url: "https://www.rba.gov.au/statistics/tables/csv/f1-data.csv",
    sourceUrl: "https://www.rba.gov.au/statistics/cash-rate/",
    parse: parseRbaF1,
  },
  {
    id: "rate_boc",
    country: "Canada",
    label: "Target for the overnight rate",
    attribution: RATE_ATTRIBUTION["Canada"]!,
    url: "https://www.bankofcanada.ca/valet/observations/V39079/json?recent=10",
    sourceUrl: "https://www.bankofcanada.ca/rates/interest-rates/canadian-interest-rates/",
    parse: (body) => {
      const d = JSON.parse(body) as { observations?: Array<Record<string, unknown>> };
      return (d.observations ?? []).flatMap((o) => {
        const date = typeof o.d === "string" ? o.d : null;
        const cell = o.V39079 as { v?: unknown } | undefined;
        const value = num(cell?.v);
        return date && value !== null ? [{ date, value }] : [];
      });
    },
  },
  {
    id: "rate_riksbank",
    country: "Sweden",
    label: "Policy rate",
    attribution: RATE_ATTRIBUTION["Sweden"]!,
    // The API requires a from-date; a rolling window keeps the response small.
    url: "https://api.riksbank.se/swea/v1/Observations/SECBREPOEFF/2026-01-01",
    sourceUrl: "https://www.riksbank.se/en-gb/statistics/policy-rate-exchange-rates-and-other-interest-rates/",
    parse: (body) => {
      const rows = JSON.parse(body) as Array<{ date?: string; value?: unknown }>;
      return rows.flatMap((r) => {
        const value = num(r.value);
        return r.date && value !== null ? [{ date: r.date, value }] : [];
      });
    },
  },
  {
    id: "rate_bcb",
    country: "Brazil",
    label: "Selic target",
    attribution: RATE_ATTRIBUTION["Brazil"]!,
    url: "https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/20?formato=json",
    sourceUrl: "https://www.bcb.gov.br/en/monetarypolicy/selicrate",
    parse: (body) => {
      const rows = JSON.parse(body) as Array<{ data?: string; valor?: unknown }>;
      return rows.flatMap((r) => {
        const date = r.data ? brDateToIso(r.data) : null;
        const value = num(r.valor);
        return date && value !== null ? [{ date, value }] : [];
      });
    },
  },
  {
    id: "rate_sarb",
    country: "South Africa",
    label: "SARB Policy Rate",
    attribution: RATE_ATTRIBUTION["South Africa"]!,
    url: "https://custom.resbank.co.za/SarbWebApi/WebIndicators/CurrentMarketRates",
    sourceUrl: "https://www.resbank.co.za/en/home/what-we-do/monetary-policy",
    parse: (body) => {
      const rows = JSON.parse(body) as Array<{ Name?: string; Date?: string; Value?: unknown }>;
      return rows.flatMap((r) => {
        if (r.Name !== "SARB Policy Rate") return [];
        const value = num(r.Value);
        return r.Date && value !== null ? [{ date: r.Date, value }] : [];
      });
    },
  },
  {
    id: "rate_boe",
    country: "United Kingdom",
    label: "Bank Rate",
    attribution: RATE_ATTRIBUTION["United Kingdom"]!,
    // IADB requires an explicit window; a rolling year keeps the CSV small
    // while still carrying enough history to see the previous level.
    buildUrl: (now) => {
      // Dateto is YESTERDAY, not today.
      //
      // HONEST NOTE ON WHY: an earlier comment here claimed the same-day
      // window CAUSED IADB's HTTP 500s. That was wrong, and disproved by
      // direct test on 2026-07-28T04:35Z — both Dateto=today and
      // Dateto=yesterday returned 200 with identical bodies.
      //
      // What the evidence actually shows: the four failures were at 00:50,
      // 01:50, 02:50 and 03:50 UTC (01:50-04:50 UK), and the last success was
      // 23:50 UTC. That is an overnight maintenance window on IADB's side,
      // and it is transient — the source recovers on its own in UK business
      // hours.
      //
      // Yesterday's date is KEPT anyway because it is strictly safer (never
      // asks for a value that may not exist yet) and a policy rate that moves
      // a handful of times a year loses nothing from a one-day lag. But it is
      // not a fix for the 500s, and labelling it as one would send the next
      // person chasing the wrong thing.
      const to = new Date(now.getTime() - 86_400_000);
      const from = new Date(to.getTime() - 365 * 86_400_000);
      return (
        "https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes" +
        `&Datefrom=${boeDate(from)}&Dateto=${boeDate(to)}` +
        "&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N"
      );
    },
    sourceUrl: "https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate",
    parse: (body) => {
      const out: RateObservation[] = [];
      for (const line of stripBom(body).split("\n").slice(1)) {
        const [rawDate, rawValue] = line.split(",");
        if (!rawDate || rawValue === undefined) continue;
        const date = boeDateToIso(rawDate);
        const value = num(rawValue);
        if (date && value !== null) out.push({ date, value });
      }
      return out;
    },
  },
  {
    id: "rate_ecb",
    country: "Euro area",
    label: "Main refinancing operations rate",
    attribution: RATE_ATTRIBUTION["Euro area"]!,
    // SDMX-CSV: flat header + one row per observation. csvdata is far cheaper
    // to parse than the JSON variant's nested structure blocks.
    url:
      "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.MRR_FR.LEV" +
      "?format=csvdata&lastNObservations=40",
    sourceUrl: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html",
    parse: (body) => {
      const lines = stripBom(body).split("\n").filter((l) => l.trim() !== "");
      const header = (lines[0] ?? "").split(",");
      const iTime = header.indexOf("TIME_PERIOD");
      const iValue = header.indexOf("OBS_VALUE");
      if (iTime < 0 || iValue < 0) return [];
      const out: RateObservation[] = [];
      for (const line of lines.slice(1)) {
        const cells = line.split(",");
        const date = (cells[iTime] ?? "").trim();
        const value = num(cells[iValue]);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null) out.push({ date, value });
      }
      return out;
    },
  },
  {
    id: "rate_norges",
    country: "Norway",
    label: "Key policy rate",
    attribution: RATE_ATTRIBUTION["Norway"]!,
    // SDMX CSV. Verified 2026-07-28: 4.25%, and the delimiter is a
    // SEMICOLON, not a comma — a comma split silently yields one column and
    // zero observations.
    url: "https://data.norges-bank.no/api/data/IR/B.KPRA.SD.R?format=csv&startPeriod=2026-01-01&locale=en",
    sourceUrl: "https://www.norges-bank.no/en/topics/Monetary-policy/Policy-rate/",
    parse: (body) => {
      const lines = stripBom(body).split("\n").filter((l) => l.trim() !== "");
      const header = (lines[0] ?? "").split(";");
      const iTime = header.indexOf("TIME_PERIOD");
      const iValue = header.indexOf("OBS_VALUE");
      // Located by NAME: this file carries 15 columns, several of them
      // label/code pairs, so positions are not safe to assume.
      if (iTime < 0 || iValue < 0) return [];
      const out: RateObservation[] = [];
      for (const line of lines.slice(1)) {
        const cells = line.split(";");
        const date = (cells[iTime] ?? "").trim();
        const value = num(cells[iValue]);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null) out.push({ date, value });
      }
      return out;
    },
  },
  {
    id: "rate_snb",
    country: "Switzerland",
    label: "SNB policy rate",
    attribution: RATE_ATTRIBUTION["Switzerland"]!,
    // RSS-CB: this feed carries the NUMBER inside the feed (cb:value), so no
    // second fetch is needed. Verified 2026-07-27.
    url: "https://www.snb.ch/public/en/rss/interestRates",
    sourceUrl: "https://www.snb.ch/en/the-snb/mandates-goals/monetary-policy/interest-rates",
    parse: (body) => {
      const out: RateObservation[] = [];
      for (const item of extractAll(stripBom(body), "item")) {
        // VERIFIED 2026-07-27T23:40Z: cb:rateName carries CODES, not prose —
        // the feed's values are SNBLZ, LSFF, R10, SARH, SNBFBF, SNBGIRO1/2,
        // Discount. SNBLZ is the policy rate (Leitzins) and read 0.00%; the
        // 0.25% nearby is LSFF, the special liquidity-shortage financing
        // rate, which is a different instrument entirely.
        const name = (extractFirst(item, "cb:rateName") ?? "").trim();
        if (name !== SNB_POLICY_RATE_CODE) continue;
        const value = num(extractFirst(item, "cb:value"));
        const pub = extractFirst(item, "pubDate") ?? "";
        const when = new Date(pub);
        if (value === null || Number.isNaN(when.getTime())) continue;
        out.push({ date: when.toISOString().slice(0, 10), value });
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------------------

/**
 * Latest observation that is not in the FUTURE.
 *
 * VERIFIED QUIRK (Brazil, 2026-07-27): SGS series 432 publishes the Selic
 * target forward — as of 27 July the newest rows were dated 3-5 August,
 * because the target is stated for the days it will be in effect until the
 * next Copom meeting. Taking "the newest row" would publish a future-dated
 * rate as today's.
 */
export function latestEffective(obs: readonly RateObservation[], now: Date): RateObservation | null {
  const today = now.toISOString().slice(0, 10);
  const past = obs.filter((o) => o.date <= today);
  if (past.length === 0) return null;
  return past.reduce((a, b) => (a.date >= b.date ? a : b));
}

export interface RateChange {
  current: RateObservation;
  prior: RateObservation;
  /** Change in basis points, from two parsed values. */
  bps: number;
  direction: "raised" | "lowered";
}

/** The most recent change within the observations we hold, if any. */
export function detectChange(obs: readonly RateObservation[], now: Date): RateChange | null {
  const current = latestEffective(obs, now);
  if (!current) return null;
  const earlier = obs
    .filter((o) => o.date < current.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const prior = earlier.find((o) => o.value !== current.value);
  if (!prior) return null;
  // Only a change AT the current observation counts: if the series already
  // moved days ago and has been flat since, that is old news.
  const mostRecentEarlier = earlier[0];
  if (!mostRecentEarlier || mostRecentEarlier.value === current.value) return null;
  const bps = Math.round((current.value - prior.value) * 100);
  return { current, prior, bps: Math.abs(bps), direction: bps > 0 ? "raised" : "lowered" };
}

/**
 * Build a change from the level we ourselves recorded last poll.
 *
 * Only for sources that publish no history (see RateSource.singleObservation).
 * The cursor is written as `${date}:${value}` after every successful poll.
 */
export function changeFromCursor(cursor: string | null, current: RateObservation): RateChange | null {
  if (!cursor) return null;
  // Split on the LAST colon: the date half contains none, but pinning the
  // separator this way survives any future date format that does.
  const sep = cursor.lastIndexOf(":");
  if (sep <= 0) return null;
  const date = cursor.slice(0, sep);
  const value = Number.parseFloat(cursor.slice(sep + 1));
  if (!Number.isFinite(value)) return null;
  // A hold is not a change, and the prior must genuinely precede the current
  // observation — equal or later dates mean we are looking at the same print.
  if (value === current.value) return null;
  if (date >= current.date) return null;
  const bps = Math.round((current.value - value) * 100);
  if (bps === 0) return null;
  return { current, prior: { date, value }, bps: Math.abs(bps), direction: bps > 0 ? "raised" : "lowered" };
}

export function draftRate(src: RateSource, change: RateChange): string {
  return (
    `${src.country}: ${src.label} ${change.direction} to ${change.current.value}% ` +
    `from ${change.prior.value}%, effective ${change.current.date}`
  );
}

export function makeRateHandler(src: RateSource) {
  return async function pollRate(env: Env, now: Date = new Date(), budget: TickBudget = newTickBudget()): Promise<void> {
    if (!budget.take(1)) return;
    const state = await getSourceState(env.DB, src.id);
    try {
      const res = await politeFetch(urlFor(src, now), { userAgent: buildUserAgent(env.CONTACT_EMAIL), timeoutMs: 20_000 });
      if (!res.ok) throw new Error(`${src.id} ${res.status}`);
      const obs = src.parse(res.body);
      if (obs.length === 0) throw new Error("parsed to zero observations");

      const current = latestEffective(obs, now);
      if (!current) throw new Error("no non-future observation");

      // BASELINE: the first time we see a series we record it and say nothing.
      // Claiming a change requires having observed the level before it.
      const seenBefore = state.cursor !== null && state.cursor !== "";

      // A history-bearing feed answers this from the feed. A source that
      // publishes only the current level answers it from what we last saw.
      const change = src.singleObservation
        ? changeFromCursor(state.cursor, current)
        : detectChange(obs, now);
      const isNews = seenBefore && change !== null && state.cursor !== `${current.date}:${current.value}`;

      const result = await insertItem(
        env.DB,
        {
          source: src.id,
          externalId: `${current.date}:${current.value}`,
          category: "rate",
          eventAt: `${current.date}T00:00:00.000Z`,
          sourceUrl: src.sourceUrl,
          payload: {
            country: src.country,
            label: src.label,
            value: current.value,
            observedDate: current.date,
            priorValue: change?.prior.value ?? null,
            priorDate: change?.prior.date ?? null,
            changeBps: change?.bps ?? null,
            direction: change?.direction ?? null,
            factLine: change ? draftRate(src, change) : `${src.country}: ${src.label} ${current.value}%, ${current.date}`,
          },
          score: isNews ? SCORE_AUTO_ALERT : SCORE_LOG_ONLY,
          status: isNews ? "new" : "logged",
        },
        now,
      );

      if (result.outcome === "inserted" && result.id !== null) {
        await recordFacts(
          env.DB,
          [
            {
              itemId: result.id,
              source: src.id,
              entity: src.country,
              metric: "policy_rate",
              value: current.value,
              occurredAt: `${current.date}T00:00:00.000Z`,
            },
          ],
          now,
        );
      }

      state.cursor = `${current.date}:${current.value}`;
      state.consecutiveFailures = 0;
      state.lastOkAt = iso(now);
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
    } catch (e) {
      state.consecutiveFailures += 1;
      state.lastPolledAt = iso(now);
      await putSourceState(env.DB, state);
      await recordSourceError(env.DB, src.id, e, now);
      log("error", "rate poll failed", { source: src.id, error: String(e), failures: state.consecutiveFailures });
      return;
    }

    // Drain: rate changes are rare, so the cap is small.
    const pending = await env.DB.prepare(
      `SELECT id, source_url, payload FROM items WHERE source = ?1 AND status = 'new' ORDER BY id LIMIT 3`,
    )
      .bind(src.id)
      .all<{ id: number; source_url: string; payload: string }>();
    for (const row of pending.results) {
      if (!budget.take(1)) break;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const result = await enqueueForApproval(env, row.id, "RATE_DECISION", payload, row.source_url, now);
      if (result.retryAfter !== null) break;
    }
  };
}
