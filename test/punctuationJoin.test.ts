import { describe, expect, it } from "vitest";
import { trimTerminalStop } from "../src/templates/render";

// p6-02 / A4. Live cards #1227 and #1241 shipped stacked punctuation at the
// attribution join. The fix must not mangle a filed company name to get it.
describe("A4: stacked punctuation, without eating an abbreviation", () => {
  it("removes the stop the join would double (the two live cards)", () => {
    expect(trimTerminalStop("Combined $69.22K.")).toBe("Combined $69.22K");
    expect(trimTerminalStop("3 insiders bought $BBBY in the past week.")).toBe(
      "3 insiders bought $BBBY in the past week",
    );
  });

  it("NEVER mangles a filed company name", () => {
    // A blind /\.$/ strip turns these into Inc, INC, Co and Ltd.
    for (const name of [
      "Butterfly Network reports a stake in Robinhood Markets, Inc.",
      "The exchange filed to remove NEONODE INC.",
      "A proposed sale of DONEGAL MUTUAL INSURANCE CO.",
      "GIC Private Ltd.",
      "5AM Opportunities II, L.P.",
    ]) {
      expect(trimTerminalStop(name)).toBe(name);
    }
  });

  it("a trailing initial keeps its stop", () => {
    expect(trimTerminalStop("Filed by Merton Carl A.")).toBe("Filed by Merton Carl A.");
  });

  it("a line with no terminal stop is untouched", () => {
    expect(trimTerminalStop("sold 499,246 $MRNA at ~$57.52")).toBe("sold 499,246 $MRNA at ~$57.52");
    expect(trimTerminalStop("")).toBe("");
  });
});
