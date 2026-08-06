import type { Payload } from "../templates/types";
import { renderEvent, renderSingleStat, type SingleStatCard } from "./cards";
import { ARCHETYPES } from "../templates/archetypes";
import { resolveAttribution } from "../templates/render";

/**
 * Which card an archetype's payload can honestly produce, if any.
 *
 * THE RULE, and it is the whole file: a card is drawn ONLY from fields the
 * payload actually carries. An archetype with no headline figure in its
 * payload gets NO card — text-only delivery — because the alternative is
 * inventing a figure to fill a template, which is the fabrication class this
 * repo exists to refuse. `docs/IMAGE_POLICY.md`: "if it did not parse, it is
 * not on the card."
 *
 * That is why this is a small table rather than a clever generic mapper. Each
 * entry names the payload fields it reads, and an archetype absent from it is
 * absent on purpose, not by oversight. Owner's build order puts "other
 * archetype templates" in phase (c); this is (a) and (b).
 */

const str = (p: Payload, k: string): string | null => {
  const v = p[k];
  return typeof v === "string" && v !== "" ? v : null;
};

interface StatSpec {
  /** Pre-computed display fields, in preference order. First hit wins. */
  readonly figure: readonly string[];
  readonly label: string;
  readonly subject: readonly string[];
  readonly rows?: ReadonlyArray<readonly [string, string]>;
}

/**
 * Only archetypes whose payloads carry a PRE-COMPUTED display figure appear
 * here. Deliberately short: several archetypes (REGULATORY_NEWS, POLICY_ACTION)
 * carry no numeric field at all by construction, so they can never have a
 * single-stat card and are correctly missing.
 */
const STAT_CARDS: Partial<Record<string, StatSpec>> = {
  CONGRESS_PTR: {
    figure: ["amountBand"],
    label: "congressional trade disclosure",
    subject: ["who", "display"],
    rows: [
      ["trade date", "tradeDate"],
      ["filed", "filedDate"],
      ["lag", "lagLine"],
    ],
  },
  INSIDER_NOTICE: {
    figure: ["aggregateMarketValue_display", "valueDisplay"],
    label: "proposed sale, filed before it happens",
    subject: ["sellerName", "who"],
    rows: [["issuer", "issuerName"], ["broker", "broker"]],
  },
  OWNERSHIP_STAKE: {
    figure: ["topPercent_display", "pctDisplay"],
    label: "beneficial ownership",
    subject: ["holderName", "who"],
    rows: [["issuer", "issuerName"]],
  },
};

export interface CardImage {
  readonly png: Uint8Array;
  readonly filename: string;
}

/**
 * Render the card for this item, or null when the payload cannot support one.
 *
 * Null is a first-class answer and callers must treat it as normal: delivery
 * falls back to text, which is exactly what happened before this lane existed.
 * A missing image is a smaller failure than a wrong one.
 */
export async function cardImageFor(archetype: string, payload: Payload): Promise<CardImage | null> {
  // EARNINGS_EVENT has NO figure by design, so it gets the event card rather
  // than being forced into a hero-number template it cannot honestly fill.
  if (archetype === "EARNINGS_EVENT") return earningsCard(payload);

  const spec = STAT_CARDS[archetype];
  if (!spec) return null;

  const pick = (keys: readonly string[]): string | null => {
    for (const k of keys) {
      const v = str(payload, k);
      if (v) return v;
    }
    return null;
  };

  const figure = pick(spec.figure);
  const subject = pick(spec.subject);
  if (!figure || !subject) return null;

  const arch = ARCHETYPES[archetype as keyof typeof ARCHETYPES];
  const attribution = arch ? resolveAttribution(arch, payload) : null;
  // No resolved citation means no card. A branded image without its source is
  // the one thing docs/IMAGE_POLICY.md will not allow to leave the building.
  if (!attribution) return null;

  const rows = (spec.rows ?? [])
    .map(([label, field]) => [label, str(payload, field)] as const)
    .filter((r): r is readonly [string, string] => r[1] !== null);

  const card: SingleStatCard = {
    kind: archetype.replace(/_/g, " "),
    attribution,
    figure,
    label: spec.label,
    subject,
    rows,
  };
  return { png: await renderSingleStat(card), filename: `${archetype.toLowerCase()}.png` };
}

/** Exported for the coverage test, which asserts the omissions are deliberate. */
export const STAT_CARD_ARCHETYPES = Object.keys(STAT_CARDS);

/**
 * The earnings event card. No figure, because the payload carries none.
 *
 * The period row appears only when the SEC stated a period; a card that
 * invented "Q2" from a filing date would be making a claim about which
 * quarter a company reported.
 */
async function earningsCard(payload: Payload): Promise<CardImage | null> {
  const name = str(payload, "displayName");
  const filed = str(payload, "filedIso");
  if (!name || !filed) return null;
  const rows: Array<readonly [string, string]> = [];
  const period = str(payload, "periodLabel");
  if (period) rows.push(["period", period]);
  const exchange = str(payload, "exchange");
  if (exchange) rows.push(["listed", exchange]);
  rows.push(["item", "8-K 2.02"]);
  return {
    png: await renderEvent({
      kind: "earnings",
      attribution: "per SEC",
      subject: name,
      headline: "Results filed with the SEC",
      rows,
    }),
    filename: "earnings_event.png",
  };
}
