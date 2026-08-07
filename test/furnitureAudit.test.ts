import { describe, expect, it } from "vitest";
import { numberCheck } from "../src/rag/validate";
import { ALL_ATTRIBUTION_FORMS } from "../src/templates/attribution";
import { DEFINITIONS } from "../src/rag/definitions";

/**
 * B-08.2: the furniture audit.
 *
 * D-73 was not "three attributions have digits". It was a CLASS: renderer-owned
 * furniture passing through a validator that reads every digit as a factual
 * claim. Three instances failed loudly. A fourth, FILING_FORM4, passed for a
 * reason that is not a reason — its payload happens to carry `formType: "4"`,
 * so the bare 4 was in `facts.numbers` by coincidence. Had that field been
 * named `form` or held the number 4 instead of the string "4", it would have
 * failed identically.
 *
 * **A validator that passes by coincidence is an untested validator.**
 *
 * So this file sweeps every digit-bearing furniture string against a payload
 * chosen to contain NO NUMBERS AT ALL. Under that payload a pass can only come
 * from a real exemption, never from a coincidental field. Anything that fails
 * here is a latent 100%-rejection waiting for the first archetype whose payload
 * lacks the lucky field.
 */

/**
 * Deliberately number-free. Not a convenience: the coincidence is the bug, so
 * the audit has to remove every opportunity for one.
 */
const NUMBERLESS_PAYLOAD = {
  factLine: "An insider filed a form with the Commission.",
  issuer: { name: "Example Corp", ticker: "EXMP" },
  who: "A Director",
} as const;

function furnitureTokens(): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = [];
  for (const f of ALL_ATTRIBUTION_FORMS) {
    if (/[0-9]/.test(f)) out.push({ kind: "attribution", text: f });
  }
  for (const d of DEFINITIONS) {
    // `term` is the label a draft names to invoke the definition. `citation`
    // is never draft copy, so it is out of scope here by design.
    if (/[0-9]/.test(d.term)) out.push({ kind: "term", text: d.term });
  }
  return out;
}

describe("B-08.2: furniture audit — nothing may pass by coincidence", () => {
  it("has a payload with genuinely no numbers, so passes cannot be luck", () => {
    const json = JSON.stringify(NUMBERLESS_PAYLOAD);
    expect(/[0-9]/.test(json)).toBe(false);
  });

  it("reports every digit-bearing furniture token and whether it survives numberCheck", () => {
    const tokens = furnitureTokens();
    expect(tokens.length).toBeGreaterThan(0);

    const failing: Array<{ kind: string; text: string; detail: string }> = [];
    for (const t of tokens) {
      const issues = numberCheck(`Example Corp filed, ${t.text}`, NUMBERLESS_PAYLOAD as never);
      const mark = issues.length === 0 ? "EXEMPT" : "CLAIMS ";
      console.log(`  ${mark} [${t.kind}] ${t.text}${issues.length ? "  -> " + issues[0]!.detail : ""}`);
      if (issues.length) failing.push({ ...t, detail: issues[0]!.detail });
    }

    // B-08.1 fixed attributions; B-08.2 fixed the registry terms behind them.
    // NOTHING digit-bearing that this repo owns may read as a claim.
    expect(failing, `furniture read as factual claims: ${JSON.stringify(failing, null, 1)}`).toEqual([]);
  });

  it("instrument identifiers are names, but bare quantities are still claims", () => {
    const P = NUMBERLESS_PAYLOAD as never;
    // Names: exempt.
    for (const ok of [
      "filed a Rule 10b5-1 trading plan",
      "disclosed under 8-K Item 4.02",
      "a Schedule 13D, not a 13G",
      "per SEC Form 144",
      "its 10-Q landed",
      "a Form 4 transaction code P",
    ]) {
      expect(numberCheck(`Example Corp ${ok}`, P), `should be exempt: ${ok}`).toEqual([]);
    }
    // Quantities: still claims, even when they sit near instrument names.
    for (const bad of [
      "revenue rose 13",
      "paid $4.02 per share",
      "filed 4 separate forms",
      "10 insiders sold",
      "its 10-Q showed 44 buyers",
    ]) {
      expect(numberCheck(`Example Corp ${bad}`, P).length, `should be a claim: ${bad}`).toBeGreaterThan(0);
    }
  });

  it("FILING_FORM4 no longer depends on its lucky formType field", () => {
    // The coincidence, removed. Before B-08.1 this exact assertion failed.
    const noFormType = { factLine: "A director bought shares.", issuer: { name: "Example Corp", ticker: "EXMP" } };
    expect(JSON.stringify(noFormType)).not.toContain("4");
    expect(numberCheck("A director bought shares, per SEC Form 4", noFormType as never)).toEqual([]);
  });

  it("the coincidence itself is still not what makes it pass", () => {
    // With formType present the answer must be the same, and for the same
    // reason. If this ever diverges from the test above, the exemption has
    // stopped working and luck has taken over again.
    const withFormType = { factLine: "A director bought shares.", formType: "4" };
    expect(numberCheck("A director bought shares, per SEC Form 4", withFormType as never)).toEqual([]);
  });
});
