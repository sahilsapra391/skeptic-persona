import { BRAND, Canvas, ensureFonts, fitText, measureText } from "./canvas";

/**
 * Card templates. Render lane v1 (owner ruling: Workers, $0/month).
 *
 * COPY LAW APPLIES TO PIXELS (docs/IMAGE_POLICY.md). Every figure on a card is
 * a pre-computed payload display field, passed in as a string. Nothing here
 * formats a number, rounds one, or does arithmetic — the same rule the model
 * lives under, enforced by the type: these take `string`, never `number`.
 */

/** 16:9, the shape X renders inline without cropping. */
export const CARD_W = 1200;
export const CARD_H = 675;
/**
 * The breakdown card is TALLER, and that is a measured decision rather than a
 * preference. A ten-row table at a legible 23px mono needs 360px, and 16:9
 * leaves 269px between the header block and the footer rule — the first
 * version ran the section strips clean off the bottom edge and collided the
 * footer with the last holding. Shrinking the type to fit would have made the
 * one card whose entire job is carrying detail the hardest one to read.
 */
export const BREAKDOWN_H = 920;

const PAD = 72;
const RULE = "#26262C";

export interface CardBase {
  /** Small eyebrow: the record type. "SENATE PTR", "FORM 4", "13F". */
  readonly kind: string;
  /** The attribution, exactly as the post carries it. */
  readonly attribution: string;
  /** Optional dateline, already formatted. */
  readonly dateline?: string;
}

function chrome(c: Canvas, base: CardBase): void {
  c.drawText("brand-sm", base.kind.toUpperCase(), PAD, PAD + 14, BRAND.GRAY, { letterSpacing: 2 });
  // The desk's own mark, bottom left, and the citation bottom right. Both are
  // furniture: they appear on every card so a screenshot always carries its
  // source, which is the whole reason the image exists.
  c.fillRect(PAD, c.height - PAD - 46, CARD_W - PAD * 2, 1, RULE);
  c.drawText("brand-sm", "skeptic.fyi", PAD, c.height - PAD, BRAND.GRAY);
  const cite = base.attribution;
  c.drawText("brand-sm", cite, CARD_W - PAD - measureText("brand-sm", cite), c.height - PAD, BRAND.GRAY);
  if (base.dateline) {
    const d = base.dateline;
    c.drawText("brand-sm", d, CARD_W - PAD - measureText("brand-sm", d), PAD + 14, BRAND.GRAY);
  }
}

export interface SingleStatCard extends CardBase {
  /** The headline figure, already formatted ("$4.2M", "-95.13%"). */
  readonly figure: string;
  /** What the figure is. One short line. */
  readonly label: string;
  /** Who or what it belongs to. */
  readonly subject: string;
  /** Up to three supporting "label: value" rows, all pre-formatted. */
  readonly rows?: ReadonlyArray<readonly [string, string]>;
}

/** One number, big. The shape most short cards want. */
export async function renderSingleStat(card: SingleStatCard): Promise<Uint8Array> {
  await ensureFonts();
  const c = new Canvas(CARD_W, CARD_H);
  chrome(c, card);

  c.drawText("brand-lg", fitText("brand-lg", card.subject, CARD_W - PAD * 2), PAD, PAD + 96, BRAND.LIGHT);
  // The hero figure is the one string that cannot be ellipsised — a truncated
  // number is a WRONG number, which is the fabrication class this repo has
  // closed twice. So an over-wide figure steps DOWN a face instead. A band
  // like "$1,000,001 - $5,000,000" is 23 characters and genuinely does not
  // fit at 76px.
  const figureW = CARD_W - PAD * 2;
  const figureFace = measureText("figure-xl", card.figure) <= figureW ? "figure-xl" : "brand-xl";
  c.drawText(figureFace, card.figure, PAD, PAD + 210, BRAND.LIGHT);
  c.drawText("brand-sm", fitText("brand-sm", card.label.toUpperCase(), CARD_W - PAD * 2), PAD, PAD + 250, BRAND.GRAY, {
    letterSpacing: 1,
  });

  let y = PAD + 320;
  for (const [k, v] of (card.rows ?? []).slice(0, 3)) {
    c.fillRect(PAD, y - 22, CARD_W - PAD * 2, 1, RULE);
    c.drawText("brand-sm", fitText("brand-sm", k.toUpperCase(), 520), PAD, y + 8, BRAND.GRAY, { letterSpacing: 1 });
    c.drawText("mono-md", v, CARD_W - PAD - measureText("mono-md", v), y + 8, BRAND.LIGHT);
    y += 56;
  }
  return c.encode();
}

export interface DiffRow {
  /** Issuer name or $TICKER, exactly as the payload resolved it. */
  readonly name: string;
  /** Pre-formatted value. */
  readonly value: string;
  /** Pre-formatted change, or null when the row has none. */
  readonly change?: string | null;
  /** Instrument label the copy law requires ("Put", "Call", "PRN"). */
  readonly tag?: string | null;
}

export interface DiffCard extends CardBase {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly DiffRow[];
}

/** A ranked list: top positions, biggest adds, biggest trims. */
export async function renderDiff(card: DiffCard): Promise<Uint8Array> {
  await ensureFonts();
  const c = new Canvas(CARD_W, CARD_H);
  chrome(c, card);
  c.drawText("brand-lg", fitText("brand-lg", card.title, CARD_W - PAD * 2), PAD, PAD + 96, BRAND.LIGHT);
  if (card.subtitle) {
    c.drawText("brand-sm", fitText("brand-sm", card.subtitle, CARD_W - PAD * 2), PAD, PAD + 130, BRAND.GRAY);
  }
  drawTable(c, card.rows, PAD + 180);
  return c.encode();
}

/**
 * The table both the diff card and the 13F breakdown draw.
 *
 * COLUMN BUDGET is the load-bearing bit. Name gets what is left after the
 * value and change columns are reserved, and it is FIT rather than clipped —
 * 87% of 13F holdings render a filed issuer name rather than a ticker, and
 * those names are long ("CHUBB LTD SWITZ"). The value column is right-aligned
 * mono so the digits line up down the card, which is the only reason to use a
 * monospace face at all.
 */
function drawTable(c: Canvas, rows: readonly DiffRow[], top: number, maxRows = 10): number {
  const VALUE_W = 210;
  const CHANGE_W = 150;
  const rowH = 36;
  const nameW = CARD_W - PAD * 2 - VALUE_W - CHANGE_W - 24;
  let y = top;
  for (const r of rows.slice(0, maxRows)) {
    const label = r.tag ? `${r.name} [${r.tag}]` : r.name;
    c.drawText("mono-md", fitText("mono-md", label, nameW), PAD, y, BRAND.LIGHT);
    const vx = CARD_W - PAD - CHANGE_W - measureText("mono-bd", r.value);
    c.drawText("mono-bd", r.value, vx, y, BRAND.LIGHT);
    if (r.change) {
      c.drawText("mono-md", r.change, CARD_W - PAD - measureText("mono-md", r.change), y, BRAND.GRAY);
    }
    c.fillRect(PAD, y + 12, CARD_W - PAD * 2, 1, RULE);
    y += rowH;
  }
  return y;
}

export interface BreakdownStrip {
  readonly label: string;
  /** Pre-computed count, e.g. "7". */
  readonly count: string;
  /** Pre-computed total, e.g. "$1.24B". */
  readonly total: string;
}

export interface BreakdownCard extends CardBase {
  /** Manager name as filed. */
  readonly manager: string;
  /** "Q2 2026 · as of Jun 30 · filed Aug 14", pre-formatted. */
  readonly periodLine: string;
  readonly aum: string;
  readonly top: readonly DiffRow[];
  /** New / Adds / Trims / Gone, each pre-aggregated. */
  readonly strips: readonly BreakdownStrip[];
}

/**
 * The 13F breakdown card: top-10 table plus the section strips.
 *
 * The owner's ruling put the FULL breakdown here rather than in a thread, so
 * this card carries what the 280-character post cannot. "Gone" is a section
 * label, never a verb — a holding absent from a filing was not necessarily
 * sold, and the copy law says so.
 */
export async function renderBreakdown(card: BreakdownCard): Promise<Uint8Array> {
  await ensureFonts();
  const c = new Canvas(CARD_W, BREAKDOWN_H);
  chrome(c, card);

  c.drawText("brand-lg", fitText("brand-lg", card.manager, CARD_W - PAD * 2 - 220), PAD, PAD + 92, BRAND.LIGHT);
  c.drawText("figure-xl", card.aum, CARD_W - PAD - measureText("figure-xl", card.aum), PAD + 108, BRAND.LIGHT);
  c.drawText("brand-sm", fitText("brand-sm", card.periodLine, CARD_W - PAD * 2 - 240), PAD, PAD + 124, BRAND.GRAY);

  c.drawText("brand-sm", "TOP POSITIONS", PAD, PAD + 178, BRAND.GRAY, { letterSpacing: 2 });
  const afterTable = drawTable(c, card.top, PAD + 216, 10);

  // Section strips, evenly divided across the width under the table. Placed
  // relative to where the table ACTUALLY ended, so a short book does not
  // leave a hole and a full one does not overrun the footer.
  const strips = card.strips.slice(0, 4);
  if (strips.length > 0) {
    const stripY = Math.min(afterTable + 56, BREAKDOWN_H - PAD - 96);
    const colW = (CARD_W - PAD * 2) / strips.length;
    for (const [i, s] of strips.entries()) {
      const x = PAD + i * colW;
      c.drawText("brand-sm", s.label.toUpperCase(), x, stripY, BRAND.GRAY, { letterSpacing: 1 });
      c.drawText("mono-bd", s.count, x, stripY + 34, BRAND.LIGHT);
      c.drawText("mono-md", fitText("mono-md", s.total, colW - 20), x + 46, stripY + 34, BRAND.GRAY);
    }
  }
  return c.encode();
}

export interface EventCard extends CardBase {
  /** Company as a cashtag when the CIK resolved, filed name when it did not. */
  readonly subject: string;
  /** What happened, in a few words. No figures. */
  readonly headline: string;
  readonly rows?: ReadonlyArray<readonly [string, string]>;
}

/**
 * An event card: something HAPPENED, and there is deliberately no number.
 *
 * The earnings lane needs this shape because it has no figure by design — the
 * results are in the issuer's press release and this desk does not extract
 * numbers from prose. Reusing the single-stat template would have meant
 * finding something to put in the hero slot, and the only honest candidates
 * were a date or a ticker dressed up as a statistic. A card with no big
 * number is the accurate rendering of a filing with no parsed number.
 */
export async function renderEvent(card: EventCard): Promise<Uint8Array> {
  await ensureFonts();
  const c = new Canvas(CARD_W, CARD_H);
  chrome(c, card);

  c.drawText("brand-xl", fitText("brand-xl", card.subject, CARD_W - PAD * 2), PAD, PAD + 150, BRAND.LIGHT);
  c.drawText("brand-lg", fitText("brand-lg", card.headline, CARD_W - PAD * 2), PAD, PAD + 208, BRAND.LIGHT);

  let y = PAD + 300;
  for (const [k, v] of (card.rows ?? []).slice(0, 3)) {
    c.fillRect(PAD, y - 22, CARD_W - PAD * 2, 1, RULE);
    c.drawText("brand-sm", fitText("brand-sm", k.toUpperCase(), 520), PAD, y + 8, BRAND.GRAY, { letterSpacing: 1 });
    c.drawText("mono-md", fitText("mono-md", v, 480), CARD_W - PAD - Math.min(measureText("mono-md", v), 480), y + 8, BRAND.LIGHT);
    y += 56;
  }
  return c.encode();
}
