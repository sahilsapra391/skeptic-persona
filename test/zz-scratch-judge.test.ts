import { describe, it } from "vitest";
import { buildPrompt } from "../src/rag/generate";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";
import type { Payload } from "../src/templates/types";

const CFTC = {
  authority: "CFTC",
  title: "CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
  categories: [],
  publishedIso: "2026-07-31T19:26:52.000Z",
  factLine:
    "CFTC: CFTC Orders George Santos to Pay $35,000 for Manipulative Trading of State-of-the-Union Event Contract",
} as unknown as Payload;

describe("scratch: prompt size", () => {
  it("measures", () => {
    const bank = OWNER_EXEMPLARS.filter((e) => e.archetype === "REGULATORY_NEWS");
    const ctx = [
      "9 prior CFTC items via press_cftc_enforcement in our lake since 2026-04-23.",
      'Prior: "CFTC Charges Service Member with Manipulative Trading of Nicolas Maduro-Related Event Contracts" (2026-07-14).',
      'Prior: "CFTC Orders Pool Operator to Pay Restitution and Penalty for Fraud" (2026-05-02).',
    ];
    const p = buildPrompt("REGULATORY_NEWS", CFTC, bank, [], { source: null, contextLines: ctx });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        systemChars: p.system.length,
        userChars: p.user.length,
        totalChars: p.system.length + p.user.length,
        approxInputTokens: Math.round((p.system.length + p.user.length) / 4),
        exemplarsForArchetype: bank.length,
        payloadJsonChars: JSON.stringify(CFTC, null, 1).length,
        contextChars: ctx.join("\n").length,
      }),
    );
  });
});
