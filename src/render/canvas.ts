import { ALPHA_B64, METRICS } from "./atlas.generated";
import { encodePng } from "./png";

/**
 * A minimal RGBA canvas with bitmap text, sized for one branded card.
 *
 * Everything here is deliberately small and boring. The only interesting part
 * is the glyph blit, and the only interesting thing about that is that the
 * atlas stores COVERAGE (8-bit alpha), not colour — so one baked glyph draws
 * in any brand colour, and the atlas stays one copy per size rather than one
 * per size-and-colour.
 */

export type FaceName = keyof typeof METRICS;

/** Brand tokens, owner-specified. Nothing else may be drawn. */
export const BRAND = {
  BLACK: "#101014",
  LIGHT: "#F4F4F5",
  GRAY: "#8E8E93",
} as const;

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function hex(css: string): Rgba {
  const h = css.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255,
  };
}

// ---------------------------------------------------------------------------
// The atlas: inflated once per isolate, never per card.
// ---------------------------------------------------------------------------

let alphaPromise: Promise<Uint8Array> | null = null;
let alpha: Uint8Array | null = null;

/**
 * Inflate the glyph coverage. Idempotent, cached per isolate, and the ONLY
 * async step in rendering — drawing itself is synchronous, so a card never
 * interleaves awaits with pixel writes.
 */
export async function ensureFonts(): Promise<void> {
  alphaPromise ??= (async () => {
    const bin = atob(ALPHA_B64);
    const packed = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i);
    const ds = new DecompressionStream("deflate");
    const w = ds.writable.getWriter();
    void w.write(packed);
    void w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  })();
  alpha = await alphaPromise;
}

type Glyph = { w: number; h: number; l: number; t: number; a: number; o: number };

function glyphOf(face: FaceName, ch: string): Glyph | null {
  const g = (METRICS[face].glyphs as Record<string, Glyph>)[ch];
  return g ?? null;
}

export function measureText(face: FaceName, text: string, letterSpacing = 0): number {
  let x = 0;
  for (const ch of text) {
    const g = glyphOf(face, ch);
    // An unmapped codepoint contributes a space's advance rather than zero, so
    // a stray character shifts the line instead of silently overlapping it.
    x += (g?.a ?? glyphOf(face, " ")?.a ?? 0) + letterSpacing;
  }
  return x;
}

export function lineHeight(face: FaceName): number {
  return METRICS[face].lineHeight;
}

/**
 * Fit `text` into `maxWidth`, ellipsising on a CHARACTER boundary.
 *
 * The case this exists for is real and common: 87% of 13F holdings resolve to
 * a filed issuer name rather than a ticker, and those names are long and
 * unlovely ("CHUBB LTD SWITZ"). A table that overflows its column is worse
 * than one that truncates, and a truncation that hides the fact it truncated
 * is worse than both — hence the ellipsis, and hence the test that renders
 * that exact name.
 */
export function fitText(face: FaceName, text: string, maxWidth: number): string {
  if (measureText(face, text) <= maxWidth) return text;
  const ell = "…";
  const ellW = measureText(face, ell);
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = glyphOf(face, ch)?.a ?? 0;
    if (w + cw + ellW > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out.trimEnd() + ell;
}

export class Canvas {
  readonly px: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: string = BRAND.BLACK,
  ) {
    this.px = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, background);
  }

  fillRect(x: number, y: number, w: number, h: number, color: string): void {
    const c = hex(color);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      let i = (py * this.width + x0) * 4;
      for (let pxi = x0; pxi < x1; pxi++) {
        this.px[i] = c.r;
        this.px[i + 1] = c.g;
        this.px[i + 2] = c.b;
        this.px[i + 3] = 255;
        i += 4;
      }
    }
  }

  private blend(x: number, y: number, c: Rgba, coverage: number): void {
    if (coverage === 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const a = (coverage * c.a) / 65025; // (cov/255) * (alpha/255)
    if (a >= 1) {
      this.px[i] = c.r;
      this.px[i + 1] = c.g;
      this.px[i + 2] = c.b;
      this.px[i + 3] = 255;
      return;
    }
    this.px[i] = Math.round(c.r * a + this.px[i]! * (1 - a));
    this.px[i + 1] = Math.round(c.g * a + this.px[i + 1]! * (1 - a));
    this.px[i + 2] = Math.round(c.b * a + this.px[i + 2]! * (1 - a));
    this.px[i + 3] = 255;
  }

  /**
   * Draw `text` with its BASELINE at `y`. Returns the pen's end x.
   *
   * `ensureFonts()` must have resolved first. It THROWS rather than drawing
   * blanks if it has not: a card that silently renders without text is the
   * worst possible failure here, because it still looks like a card and the
   * owner would paste it.
   */
  drawText(
    face: FaceName,
    text: string,
    x: number,
    y: number,
    color: string,
    opts: { letterSpacing?: number; alpha?: number } = {},
  ): number {
    if (!alpha) throw new Error("render: ensureFonts() must be awaited before drawing text");
    const blob = alpha;
    const c = hex(color);
    if (opts.alpha !== undefined) c.a = Math.round(opts.alpha * 255);
    const spacing = opts.letterSpacing ?? 0;
    const ascent = METRICS[face].ascent;
    let penX = Math.round(x);
    for (const ch of text) {
      const g = glyphOf(face, ch);
      if (!g) {
        penX += (glyphOf(face, " ")?.a ?? 0) + spacing;
        continue;
      }
      // `t` is measured from the ascender line the rasteriser drew from, so
      // the baseline sits `ascent` below it.
      const top = Math.round(y) - ascent + g.t;
      for (let gy = 0; gy < g.h; gy++) {
        const row = g.o + gy * g.w;
        for (let gx = 0; gx < g.w; gx++) {
          this.blend(penX + g.l + gx, top + gy, c, blob[row + gx]!);
        }
      }
      penX += g.a + spacing;
    }
    return penX;
  }

  encode(): Promise<Uint8Array> {
    return encodePng(this.width, this.height, this.px);
  }
}
