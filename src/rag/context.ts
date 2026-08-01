import type { Payload } from "../templates/types";

// LAKE CONTEXT for the generation prompt: what OUR OWN data lake holds about
// this item's actor and source. Every line is a fixed template filled from a
// D1 query — no free text, no claims about the world, only counts, dates,
// titles and values we recorded ourselves. That makes each line true by
// construction and safe for the validator whitelist.
//
// The honesty rule from the lookback engine carries over: every count states
// the window it was observed in ("since <date>"). No superlatives here at
// all — record/streak claims stay with the gated template beats and their
// 90-day coverage floor.

/**
 * Payload key(s) that identify "the same actor" per archetype, tried in
 * order; dots reach nested fields. A key missing from the payload degrades
 * to source-level context — never a guess. Keys corrected against ingester
 * payload shapes in review: Form 4 nests issuer.{cik,ticker}; Form 144
 * carries issuerCik; Reg SHO uses symbol; Senate PTRs say `who` where House
 * says `member`.
 */
const ENTITY_KEYS: Record<string, readonly string[]> = {
  REGULATORY_NEWS: ["authority"],
  CONGRESS_PTR: ["member", "who"],
  RATE_DECISION: ["country"],
  FILING_8K: ["cik", "ticker"],
  FILING_FORM4: ["issuer.cik", "issuer.ticker"],
  OWNERSHIP_STAKE: ["issuerCik", "ticker"],
  INSIDER_NOTICE: ["issuerCik"],
  HALT: ["symbol"],
  SETTLEMENT_FAILURE: ["symbol"],
  PRODUCT_RECALL: ["firm"],
};

function valueAtPath(payload: Payload, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), payload);
}

const MAX_LINES = 4;
const MAX_TITLE_CHARS = 140;

export interface LakeContext {
  /** Prompt-ready lines; empty when the lake holds nothing relevant. */
  lines: string[];
}

interface ItemRow {
  id: number;
  source: string;
  archetype: string;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length <= MAX_TITLE_CHARS ? t : `${t.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

async function priorItems(
  db: D1Database,
  opts: { source: string; excludeItemId: number; entityPath?: string; entityValue?: string },
): Promise<{ count: number; since: string | null; recent: Array<{ title: string; date: string }> }> {
  const entityClause = opts.entityPath ? "AND json_extract(payload, ?3) = ?4" : "";
  const binds: unknown[] = [opts.source, opts.excludeItemId];
  if (opts.entityPath) binds.push(opts.entityPath, opts.entityValue);

  const agg = await db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(COALESCE(event_at, fetched_at)) AS since FROM items
       WHERE source = ?1 AND id <> ?2 ${entityClause}`,
    )
    .bind(...binds)
    .first<{ n: number; since: string | null }>();
  const count = agg?.n ?? 0;
  if (count === 0) return { count: 0, since: null, recent: [] };

  const rows = await db
    .prepare(
      `SELECT COALESCE(json_extract(payload, '$.title'), json_extract(payload, '$.factLine')) AS t,
              substr(COALESCE(event_at, fetched_at), 1, 10) AS d
       FROM items
       WHERE source = ?1 AND id <> ?2 ${entityClause}
       ORDER BY id DESC LIMIT 2`,
    )
    .bind(...binds)
    .all<{ t: string | null; d: string | null }>();
  return {
    count,
    since: agg?.since?.slice(0, 10) ?? null,
    recent: rows.results
      .filter((r): r is { t: string; d: string } => typeof r.t === "string" && r.t.length > 0 && typeof r.d === "string")
      .map((r) => ({ title: clip(r.t), date: r.d })),
  };
}

/**
 * Build the LAKE CONTEXT block for one item. Read-only; a query failure
 * degrades to fewer lines, never blocks generation.
 */
export async function lakeContext(db: D1Database, item: ItemRow, payload: Payload): Promise<LakeContext> {
  const lines: string[] = [];
  try {
    // Entity-level first (the sharper context), source-level as the floor.
    let entityPath: string | undefined;
    let entityValue: string | undefined;
    for (const key of ENTITY_KEYS[item.archetype] ?? []) {
      const v = valueAtPath(payload, key);
      if (typeof v === "string" && v.length > 0) {
        entityPath = `$.${key}`;
        entityValue = v;
        break;
      }
    }

    if (entityPath && entityValue) {
      const ent = await priorItems(db, { source: item.source, excludeItemId: item.id, entityPath, entityValue });
      if (ent.count > 0 && ent.since) {
        lines.push(`${ent.count} prior ${entityValue} item${ent.count === 1 ? "" : "s"} via ${item.source} in our lake since ${ent.since}.`);
        for (const r of ent.recent) lines.push(`Prior: "${r.title}" (${r.date}).`);
      }
    }

    if (lines.length === 0) {
      const src = await priorItems(db, { source: item.source, excludeItemId: item.id });
      if (src.count > 0 && src.since) {
        lines.push(`${src.count} prior ${item.source} items in our lake since ${src.since}.`);
        for (const r of src.recent) lines.push(`Prior: "${r.title}" (${r.date}).`);
      }
    }

    // Rates need no special case: their payloads already carry priorValue /
    // priorDate / changeBps pre-computed at ingest, which the prompt's DATA
    // block shows the model directly.
  } catch {
    // Context is an enrichment, never a gate.
  }
  return { lines: lines.slice(0, MAX_LINES) };
}
