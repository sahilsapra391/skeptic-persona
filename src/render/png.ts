/**
 * A PNG encoder in plain TypeScript, for the card render lane.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY. Telegram and X both refuse SVG as a
 * photo, so the Worker has to emit a raster image. The repo forbids runtime
 * npm dependencies in the Worker; a WASM rasteriser is ~2MB of vendored binary
 * plus real CPU per card; Cloudflare Browser Rendering is metered with no free
 * allocation on Workers Paid. Encoding PNG by hand is the only path that is
 * genuinely $0/month at runtime, and PNG is a small format: a header, a zlib
 * stream of filtered scanlines, and a CRC per chunk.
 *
 * The zlib stream comes from `CompressionStream("deflate")`, which is a Web
 * Standard present in workerd — verified by probe before this was written, not
 * assumed: it emits a real zlib wrapper (0x78 0x9C), which is exactly what an
 * IDAT chunk wants. `deflate-raw` would NOT work here; that is the distinction
 * the spec draws and the one an IDAT chunk cares about.
 */

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Standard PNG/zlib CRC-32, table built once per isolate. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/**
 * RGBA (8-bit, colour type 6) with the UP filter on every row after the first.
 *
 * The filter choice is worth a line: a branded card is mostly flat fill, so
 * "this row minus the row above" is almost entirely zeros and deflate crushes it to
 * near nothing. Filter 0 (None) on 1200x675 leaves deflate to find the
 * redundancy itself and produces a file several times larger for the same
 * pixels. First row has nothing above it, so it stays None.
 */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    const src = y * stride;
    if (y === 0) {
      raw[dst] = 0; // None
      raw.set(rgba.subarray(src, src + stride), dst + 1);
    } else {
      raw[dst] = 2; // Up
      const prev = src - stride;
      for (let i = 0; i < stride; i++) raw[dst + 1 + i] = (rgba[src + i]! - rgba[prev + i]! + 256) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = await deflate(raw);
  const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
