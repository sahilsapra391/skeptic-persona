#!/usr/bin/env python3
"""
BUILD-TIME ONLY. Bakes the brand fonts into a bitmap atlas the Worker can draw
with, so card rendering needs zero runtime dependencies and costs $0/month.

Why an atlas at all. The Worker has to emit a raster image (Telegram and X
both refuse SVG as a photo), and the repo forbids runtime npm dependencies in
the Worker. A WASM rasterizer would be ~2MB of vendored binary and real CPU
per card; Cloudflare Browser Rendering is metered with no free allocation on
Workers Paid. Pre-rasterised glyphs are the only option that is genuinely free
at runtime, and the brand fonts survive intact because they are baked in here
rather than approximated at runtime.

Output: src/render/atlas.generated.ts — metrics as plain JSON, alpha coverage
as one deflated base64 blob the Worker inflates once per isolate with
DecompressionStream (verified present in workerd).

Usage:  python3 scripts/build-font-atlas.py <font-dir>

FONT LICENCES. Archivo and IBM Plex Mono are both SIL Open Font License 1.1,
which permits bundling and derivative works. Attribution and the licence text
live in docs/IMAGE_POLICY.md; this file is the mechanism, that file is the
record.
"""
import base64
import json
import sys
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASCII = "".join(chr(c) for c in range(32, 127))
# Extra glyphs real copy actually uses. The em-dash is deliberately absent:
# it is banned in post copy, so it must not be renderable on a card either.
EXTRA = "’‘“”…·£€¥→"
FIGURES = "0123456789$.,%+-KMBT/() "

# face name -> (file, variation axes or None, px size, charset)
FACES = {
    "brand-xl": ("Archivo[wdth,wght].ttf", {"wght": 700, "wdth": 100}, 46, ASCII + EXTRA),
    "brand-lg": ("Archivo[wdth,wght].ttf", {"wght": 600, "wdth": 100}, 26, ASCII + EXTRA),
    "brand-sm": ("Archivo[wdth,wght].ttf", {"wght": 500, "wdth": 100}, 19, ASCII + EXTRA),
    # The hero figure is digits-and-units only: a full ASCII atlas at 76px
    # would be ~470KB of alpha for glyphs no card ever draws at that size.
    "figure-xl": ("IBMPlexMono-Medium.ttf", None, 76, FIGURES),
    "mono-md": ("IBMPlexMono-Regular.ttf", None, 23, ASCII + EXTRA),
    "mono-bd": ("IBMPlexMono-Medium.ttf", None, 23, ASCII + EXTRA),
}


def load(font_dir: Path, filename: str, axes, px: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(font_dir / filename), px)
    if axes:
        try:
            names = [a["name"].decode() if isinstance(a["name"], bytes) else str(a["name"]) for a in f.get_variation_axes()]
            f.set_variation_by_axes([axes.get(n.strip().lower(), axes.get(n.strip(), 0)) for n in
                                     ["wdth" if "width" in n.lower() else "wght" for n in names]])
        except Exception:
            # Some builds expose axes by tag order (wdth, wght) instead.
            f.set_variation_by_axes([axes.get("wdth", 100), axes.get("wght", 400)])
    return f


def main() -> int:
    font_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/fonts")
    faces = {}
    blob = bytearray()

    for name, (filename, axes, px, charset) in FACES.items():
        font = load(font_dir, filename, axes, px)
        ascent, descent = font.getmetrics()
        glyphs = {}
        for ch in dict.fromkeys(charset):  # dedupe, keep order
            # Render on a generous canvas, then crop to the inked box so the
            # atlas stores coverage rather than padding.
            pad = px
            img = Image.new("L", (px * 3 + pad * 2, px * 3 + pad * 2), 0)
            d = ImageDraw.Draw(img)
            d.text((pad, pad), ch, font=font, fill=255)
            box = img.getbbox()
            advance = int(round(font.getlength(ch)))
            if box is None:  # whitespace
                glyphs[ch] = {"w": 0, "h": 0, "l": 0, "t": 0, "a": advance, "o": len(blob)}
                continue
            x0, y0, x1, y1 = box
            crop = img.crop(box)
            w, h = crop.size
            if w > 255 or h > 255:
                raise SystemExit(f"glyph {ch!r} in {name} is {w}x{h}; atlas stores u8 dimensions")
            glyphs[ch] = {
                "w": w,
                "h": h,
                "l": x0 - pad,          # left bearing relative to the pen
                "t": y0 - pad,          # top relative to the pen's ascender line
                "a": advance,
                "o": len(blob),
            }
            blob.extend(crop.tobytes())
        faces[name] = {
            "px": px,
            "ascent": ascent,
            "lineHeight": ascent + descent,
            "glyphs": glyphs,
        }
        print(f"  {name:10s} {px:3d}px  {len(glyphs):3d} glyphs  blob now {len(blob) // 1024}KB")

    packed = zlib.compress(bytes(blob), 9)
    b64 = base64.b64encode(packed).decode()
    print(f"\nalpha blob {len(blob) // 1024}KB raw -> {len(packed) // 1024}KB deflated -> {len(b64) // 1024}KB base64")

    out = Path("src/render/atlas.generated.ts")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "// GENERATED by scripts/build-font-atlas.py. Do not edit.\n"
        "//\n"
        "// Bitmap coverage baked from Archivo and IBM Plex Mono (both SIL OFL 1.1;\n"
        "// attribution in docs/IMAGE_POLICY.md). The Worker draws cards from this\n"
        "// rather than rasterising at runtime, which is what makes the render lane\n"
        "// cost $0/month with no runtime dependency.\n"
        "//\n"
        "// METRICS is plain JSON. ALPHA_B64 is the concatenated 8-bit coverage of\n"
        "// every glyph, deflated; the Worker inflates it once per isolate.\n\n"
        f"export const METRICS = {json.dumps(faces, separators=(',', ':'), ensure_ascii=False)} as const;\n\n"
        f'export const ALPHA_B64 =\n  "{b64}";\n'
    )
    print(f"wrote {out} ({out.stat().st_size // 1024}KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
