import { describe, expect, it } from "vitest";
import { encodePng } from "../src/render/png";
import { Canvas, ensureFonts, fitText, measureText, BRAND } from "../src/render/canvas";
import { renderSingleStat, renderDiff, renderBreakdown, CARD_W, CARD_H } from "../src/render/cards";

// THE RENDER LANE (owner ruling: Workers, $0/month).
//
// Everything here checks two things: the bytes are a real PNG a client will
// accept, and the copy law that governs text also governs pixels.

function readChunks(png: Uint8Array): Array<{ type: string; length: number }> {
  const out: Array<{ type: string; length: number }> = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at < png.length) {
    const len = dv.getUint32(at);
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    out.push({ type, length: len });
    at += 12 + len;
  }
  return out;
}

describe("the PNG encoder", () => {
  it("emits a signature, IHDR, IDAT and IEND, in that order", async () => {
    const px = new Uint8Array(4 * 4 * 4).fill(200);
    const png = await encodePng(4, 4, px);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(readChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("writes the declared dimensions and RGBA colour type", async () => {
    const png = await encodePng(7, 3, new Uint8Array(7 * 3 * 4));
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBe(7); // IHDR width
    expect(dv.getUint32(20)).toBe(3); // IHDR height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // colour type 6 = truecolour + alpha
  });

  it("refuses a pixel buffer that does not match the dimensions", async () => {
    await expect(encodePng(4, 4, new Uint8Array(10))).rejects.toThrow(/expected 64 bytes/);
  });

  it("round-trips through DecompressionStream, so the IDAT really is zlib", async () => {
    const w = 5;
    const h = 2;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i++) px[i] = (i * 7) % 256;
    const png = await encodePng(w, h, px);
    const idatStart = 8 + 12 + 13 + 8;
    const idatLen = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(8 + 12 + 13);
    const ds = new DecompressionStream("deflate");
    const wr = ds.writable.getWriter();
    void wr.write(png.slice(idatStart, idatStart + idatLen));
    void wr.close();
    const raw = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    // One filter byte per row plus the scanline.
    expect(raw.length).toBe(h * (w * 4 + 1));
    expect(raw[0]).toBe(0); // first row: None
    expect(raw[w * 4 + 1]).toBe(2); // second row: Up
  });
});

describe("text", () => {
  it("throws rather than drawing a card with no text on it", () => {
    const c = new Canvas(10, 10);
    // A blank card still looks like a card, and the owner would paste it.
    expect(() => c.drawText("brand-sm", "x", 0, 0, BRAND.LIGHT)).toThrow(/ensureFonts/);
  });

  it("fits a long filed issuer name and marks the truncation", async () => {
    await ensureFonts();
    // THE case: 87% of 13F holdings render a filed issuer name, not a ticker.
    const name = "CHUBB LTD SWITZ";
    const full = measureText("mono-md", name);
    expect(fitText("mono-md", name, full + 10)).toBe(name); // fits, untouched
    const squeezed = fitText("mono-md", name, full / 2);
    expect(squeezed.endsWith("…")).toBe(true);
    expect(squeezed.length).toBeLessThan(name.length);
    expect(measureText("mono-md", squeezed)).toBeLessThanOrEqual(full / 2);
  });

  it("an unmapped glyph advances instead of collapsing the line", async () => {
    await ensureFonts();
    const withEmoji = measureText("brand-sm", "a\u{1F600}b");
    const withSpace = measureText("brand-sm", "a b");
    expect(withEmoji).toBe(withSpace);
  });
});

describe("cards", () => {
  const base = { kind: "form 4", attribution: "per SEC Form 4", dateline: "Aug 6" };

  it("renders a single-stat card at 16:9 and decodes as a PNG", async () => {
    const png = await renderSingleStat({
      ...base,
      figure: "$4.2M",
      label: "open-market sale",
      subject: "A CEO sold their own company's stock",
      rows: [
        ["trade date", "June 12"],
        ["code", "S"],
      ],
    });
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBe(CARD_W);
    expect(dv.getUint32(20)).toBe(CARD_H);
    expect(readChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    // A flat branded card must stay small enough to send as a photo.
    expect(png.length).toBeLessThan(300_000);
  });

  it("renders the 13F breakdown with a full top-10 and long issuer names", async () => {
    const png = await renderBreakdown({
      kind: "13F",
      attribution: "per SEC",
      manager: "BERKSHIRE HATHAWAY INC",
      periodLine: "Q2 2026 · as of Jun 30 · filed Aug 14",
      aum: "$1.24T",
      top: Array.from({ length: 10 }, (_, i) => ({
        name: i === 0 ? "CHUBB LTD SWITZ" : `HOLDING NUMBER ${i} WITH A LONG FILED NAME INC`,
        value: `$${10 - i}.42B`,
        change: i % 2 ? "+12.5%" : null,
        tag: i === 3 ? "Put" : null,
      })),
      strips: [
        { label: "new", count: "7", total: "$1.24B" },
        { label: "adds", count: "12", total: "$820M" },
        { label: "trims", count: "9", total: "$640M" },
        { label: "gone", count: "4", total: "$210M" },
      ],
    });
    expect(readChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(png.length).toBeLessThan(400_000);
  });

  it("steps the hero figure DOWN a face rather than truncating a number", async () => {
    // A truncated number is a WRONG number. The widest real band,
    // "$1,000,001 - $5,000,000", does not fit at 76px.
    const { measureText } = await import("../src/render/canvas");
    const wide = "$1,000,001 - $5,000,000";
    expect(measureText("figure-xl", wide)).toBeGreaterThan(CARD_W - 144);
    expect(measureText("brand-xl", wide)).toBeLessThanOrEqual(CARD_W - 144);
    const png = await renderSingleStat({ ...base, figure: wide, label: "purchase", subject: "A senator" });
    expect(readChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("renders a diff card", async () => {
    const png = await renderDiff({
      ...base,
      kind: "13F diff",
      title: "Biggest adds",
      subtitle: "quarter over quarter",
      rows: [
        { name: "$AAPL", value: "$2.65B", change: "+204%" },
        { name: "CHUBB LTD SWITZ", value: "$1.10B", change: "-95.13%" },
      ],
    });
    expect(readChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });
});

describe("the render budget, in numbers", () => {
  it("stays inside the Worker bundle and CPU envelope", async () => {
    const { ALPHA_B64 } = await import("../src/render/atlas.generated");
    // The atlas is the whole runtime cost of this lane. 177KB of raw alpha
    // coverage, deflated to ~55KB, carried as base64 in the bundle. Workers
    // Paid allows 10MB compressed, so this is ~1% of the budget.
    expect(ALPHA_B64.length).toBeLessThan(120_000);

    // A full card end to end, measured rather than asserted in prose. The
    // 13F breakdown is the heaviest: 1200x920 RGBA is 4.4MB of pixels to
    // filter and deflate.
    const t0 = Date.now();
    await renderBreakdown({
      kind: "13F",
      attribution: "per SEC",
      manager: "BERKSHIRE HATHAWAY INC",
      periodLine: "Q2 2026",
      aum: "$1.24T",
      top: Array.from({ length: 10 }, (_, i) => ({ name: `HOLDING ${i}`, value: "$1.00B", change: "+1%" })),
      strips: [{ label: "new", count: "7", total: "$1.24B" }],
    });
    const ms = Date.now() - t0;
    console.log(`breakdown card rendered in ${ms}ms`);
    // Generous, because CI machines vary. The point of the bound is to catch
    // an accidental order-of-magnitude regression, not to police milliseconds.
    expect(ms).toBeLessThan(5_000);
  });
});

describe("which archetypes get a card, and which correctly do not", () => {
  it("renders only from fields the payload actually carries", async () => {
    const { cardImageFor } = await import("../src/render/forArchetype");
    // A real CONGRESS_PTR payload shape.
    const ptr = {
      chamber: "senate",
      who: "Moreno, Bernardo",
      amountBand: "$1,001 - $15,000",
      tradeDate: "07/21/2026",
      filedDate: "07/27/2026",
    };
    const img = await cardImageFor("CONGRESS_PTR", ptr);
    expect(img, "a PTR with a band and a name must card").not.toBeNull();
    expect(img!.filename).toBe("congress_ptr.png");

    // Same archetype, no band parsed -> NO image. Inventing a figure to fill
    // the template is the fabrication class this repo refuses.
    expect(await cardImageFor("CONGRESS_PTR", { chamber: "senate", who: "Moreno, Bernardo" })).toBeNull();
    // No resolvable citation -> no card. A branded image without its source
    // is the one thing IMAGE_POLICY.md will not let out.
    expect(await cardImageFor("CONGRESS_PTR", { ...ptr, chamber: "atlantis" })).toBeNull();
  });

  it("archetypes with no numeric field are absent ON PURPOSE", async () => {
    const { cardImageFor, STAT_CARD_ARCHETYPES } = await import("../src/render/forArchetype");
    // REGULATORY_NEWS and POLICY_ACTION carry no parsed numbers by
    // construction ("these sources carry no parsed numbers, so the beats
    // carry none either"), so they can never have a single-stat card.
    for (const a of ["REGULATORY_NEWS", "POLICY_ACTION"]) {
      expect(STAT_CARD_ARCHETYPES).not.toContain(a);
      expect(await cardImageFor(a, { authority: "SEC", title: "x", factLine: "SEC: x" })).toBeNull();
    }
    // The table is short and every entry is deliberate; this pins the set so
    // an addition is a decision rather than a drift.
    expect([...STAT_CARD_ARCHETYPES].sort()).toEqual(["CONGRESS_PTR", "INSIDER_NOTICE", "OWNERSHIP_STAKE"]);
  });
});
