import { describe, it } from "vitest";
import { ROWS } from "./tmp-payloads";
import { ARCHETYPES } from "../src/templates/archetypes";
import { renderPost, EMPTY_ROTATION } from "../src/templates/render";

const rows = ROWS;

describe("probe", () => {
  it("renders real congress payloads", () => {
    let ok = 0;
    const fails: Record<string, number> = {};
    const samples: string[] = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      let res: any;
      try {
        res = renderPost(ARCHETYPES.CONGRESS_PTR, p, { seed: `CONGRESS_PTR:${r.id}`, rotation: EMPTY_ROTATION });
      } catch (e) {
        fails["THREW:" + String(e).slice(0, 120)] = (fails["THREW:" + String(e).slice(0, 120)] ?? 0) + 1;
        continue;
      }
      if (res.ok) {
        ok++;
        if (samples.length < 3) samples.push(`#${r.id} ${res.skeletonId}/${res.beatId}\n${res.text}`);
      } else {
        fails[res.reason] = (fails[res.reason] ?? 0) + 1;
        if (samples.length < 6) samples.push(`#${r.id} FAIL ${res.reason}`);
      }
    }
    console.log("TOTAL", rows.length, "OK", ok, "FAILS", JSON.stringify(fails, null, 1));
    console.log(samples.join("\n---\n"));
  });
});
