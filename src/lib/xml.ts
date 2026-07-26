// Lightweight regex-first XML/feed helpers. Deliberately not a full XML
// parser: free-tier Workers get 10 ms CPU per invocation, our feeds are
// small and well-known, and ingester tests pin real captured fixtures so
// format drift breaks loudly in CI rather than silently in prose.

/** Strip a UTF-8 BOM (Fed RSS, Nasdaq halts RSS, and House XML all lead with one). */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode the XML named entities plus numeric (decimal and hex) references. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isNaN(cp) || cp > 0x10ffff ? whole : String.fromCodePoint(cp);
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isNaN(cp) || cp > 0x10ffff ? whole : String.fromCodePoint(cp);
    }
    return NAMED[body] ?? whole;
  });
}

/** Unwrap <![CDATA[...]]> if present (Fed RSS wraps most fields in CDATA). */
export function unwrapCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? (m[1] ?? "") : s;
}

// Attribute region of an open tag: quoted strings may contain '>', so skip
// over them instead of stopping at the first '>' like a naive [^>]* would.
const ATTRS = `(?:\\s(?:"[^"]*"|'[^']*'|[^>"'])*)?`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * All inner contents of `<tag ...>...</tag>` occurrences, in document order.
 * Handles attributes (including quoted values containing '>') and namespaced
 * tags when given the exact qualified name (e.g. "ndaq:HaltTime").
 * Non-greedy; does not handle nested same-name tags (none of our feeds nest
 * identical tag names).
 */
export function extractAll(xml: string, tag: string): string[] {
  const esc = escapeRe(tag);
  const re = new RegExp(`<${esc}${ATTRS}>([\\s\\S]*?)</${esc}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

export function extractFirst(xml: string, tag: string): string | null {
  return extractAll(xml, tag)[0] ?? null;
}

/**
 * Value of `attr` on the first `<tag ...>` occurrence (self-closing or not).
 * Accepts double- or single-quoted values.
 */
export function extractAttr(xml: string, tag: string, attr: string): string | null {
  const tagMatch = new RegExp(`<${escapeRe(tag)}(${ATTRS})>`).exec(xml);
  if (!tagMatch || !tagMatch[1]) return null;
  const attrMatch = new RegExp(`(?:^|\\s)${escapeRe(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tagMatch[1]);
  return attrMatch ? (attrMatch[1] ?? attrMatch[2] ?? null) : null;
}
