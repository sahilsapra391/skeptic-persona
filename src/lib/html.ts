// Regex-first HTML-to-text, shared by ingest-time capture (press RSS
// descriptions) and generation-time source fetch. Zero-dep on purpose: this
// runs on the Worker's CPU budget against bodies we cap before stripping.

/** Never run the stripper over more than this many raw characters. */
export const RAW_BODY_CAP = 300_000;

/** Remove bare URLs: grounding text feeds the generation prompt, which is
 *  URL-free by contract (the model must never see or emit one — the source
 *  link rides in a Telegram reply, not the post). */
export function scrubUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    // Scheme-less official domains ("SEC.gov", "CFTC.gov/PressRoom") ride in
    // agency boilerplate constantly; echoed into a post they'd be linkified
    // by X and mis-counted by our weighted-length counter (review finding).
    .replace(/\b[a-z0-9][a-z0-9.-]*\.(?:gov|mil|int|europa\.eu|org\.uk|or\.jp|gov\.au|gov\.br|co\.za)\b(?:\/\S*)?/gi, " ")
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * Magic numbers for formats that are NOT markup. Checked on the leading
 * bytes, because content-type cannot be trusted -- this repo already
 * documents that SEC's content-type headers lie.
 */
const BINARY_MAGIC: readonly string[] = [
  "%PDF-", // PDF
  "PK\u0003\u0004", // zip / xlsx / docx
  "\u007fELF",
  "\u0089PNG",
  "GIF8",
  "\u00ff\u00d8\u00ff", // JPEG
];

/**
 * Is this a binary payload wearing an HTML content-type?
 *
 * VERIFIED LIVE 2026-08-01, and this is not hypothetical. Three press feeds
 * ship no usable <description>, and two of them -- SEC litigation and Bank of
 * Japan -- link straight to PDFs:
 *
 *   https://www.sec.gov/files/litigation/admin/2026/ia-6984.pdf
 *   http://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/mpr260731b.pdf
 *
 * Tag-stripping a PDF does not fail. It yields 106,641 characters of object
 * tables and byte offsets -- "/Length 93", "/Prev 223302", "/Size 312" -- and
 * those are DIGITS. Because the generation validator widens its whitelist to
 * payload union source, a PDF's internal structure would have licensed its
 * own numbers as facts our posts may state. That is non-negotiable #1 reached
 * through a fetch that returned 200 and text that was not empty.
 */
export function looksBinary(body: string): boolean {
  const head = body.slice(0, 8);
  if (BINARY_MAGIC.some((m) => head.startsWith(m))) return true;
  // Anything else non-textual: NUL bytes and decoder replacement characters
  // do not occur in real markup at density.
  const sample = body.slice(0, 2_000);
  if (sample.length === 0) return false;
  let bad = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0 || c === 0xfffd) bad += 1;
  }
  return bad / sample.length > 0.02;
}

export function htmlToText(html: string): string {
  // A PDF is not markup. Returning empty makes every caller fail closed:
  // src/rag/sourceText.ts already discards an empty extraction, so a
  // PDF-linked item keeps raw_text NULL and grounds on payload alone
  // instead of on byte offsets.
  if (looksBinary(html)) return "";
  return html
    .slice(0, RAW_BODY_CAP)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|head|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    // An UNCLOSED script/style tail (typically the 300k cap slicing through
    // an inline state blob) would otherwise survive tag-stripping as text
    // and flood the grounding window with licensed junk numbers.
    .replace(/<(script|style)\b[^>]*>(?:(?!<\/\1)[\s\S])*$/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      const cp = parseInt(h, 16);
      return cp > 31 && cp < 0x10ffff ? String.fromCodePoint(cp) : " ";
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      const cp = parseInt(d, 10);
      return cp > 31 && cp < 0x10ffff ? String.fromCodePoint(cp) : " ";
    })
    .replace(/[ \t\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
