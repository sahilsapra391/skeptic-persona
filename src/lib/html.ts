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

export function htmlToText(html: string): string {
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
