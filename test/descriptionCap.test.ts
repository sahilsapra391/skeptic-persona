import { describe, expect, it } from "vitest";
import RBI from "./fixtures/press-rbi.xml.fixture?raw";
import GAO from "./fixtures/press-gao.xml.fixture?raw";
import { parsePressFeed } from "../src/ingesters/regulatoryPress";
import { groundingFacts } from "../src/rag/validate";
import { htmlToText, scrubUrls } from "../src/lib/html";
import { decodeEntities } from "../src/lib/xml";

/** The licensed numeric set for a body of grounding text. */
function licensedNumbers(text: string): Set<string> {
  const g = groundingFacts(text) as unknown as Record<string, unknown>;
  const n = g["numbers"];
  return new Set((n instanceof Set ? [...n] : (n as unknown[])).map(String));
}

/** The untruncated body of one item, exactly as parseDescription builds it minus the cap. */
function fullBody(xml: string, index: number): string {
  const raw = xml.split(/<item[\s>]|<entry[\s>]/).slice(1)[index] ?? "";
  const m = raw.match(/<(?:description|summary|content)>([\s\S]*?)<\/(?:description|summary|content)>/);
  const unwrapped = (m?.[1] ?? "").replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
  return scrubUrls(htmlToText(decodeEntities(unwrapped))).trim();
}

describe("the description cap must not invent a number", () => {
  it("licenses nothing the untruncated record does not also license", () => {
    // THE DEFECT: a hard .slice(0, 2000) cut inside "July 01, 2026" stored
    // "...July 01, 20" and groundingFacts licensed 20 — a value the source
    // never printed. items.raw_text is merged into the licensed fact set at
    // validateVariant, so numberCheck passes a draft using it and every other
    // gate is green. The parse artefact IS the licensed field, which is the
    // one class the fabrication floor cannot catch by construction.
    for (const [name, xml] of [["rbi", RBI], ["gao", GAO]] as const) {
      const items = parsePressFeed(xml as string);
      items.forEach((item, i) => {
        const stored = (item as { description?: string | null }).description ?? "";
        if (!stored) return;
        const invented = [...licensedNumbers(stored)].filter((n) => !licensedNumbers(fullBody(xml as string, i)).has(n));
        expect(invented, `${name}#${i} licensed numbers absent from the full record: ${JSON.stringify(invented)}`).toEqual([]);
      });
    }
  });

  it("still caps long bodies, and cuts on whitespace", () => {
    const items = parsePressFeed(RBI as string);
    const long = items.map((i) => (i as { description?: string | null }).description ?? "").filter((d) => d.length > 1500);
    expect(long.length).toBeGreaterThan(0); // the fixture still exercises the cap
    for (const d of long) {
      expect(d.length).toBeLessThanOrEqual(2000);
      expect(d).not.toMatch(/\s$/); // trimmed
      expect(d.slice(-1)).not.toBe(""); // non-empty
    }
  });
});
