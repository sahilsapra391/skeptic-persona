import { describe, expect, it } from "vitest";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";
import { MIN_TAKE_WEIGHTED, TARGET_TAKE_WEIGHTED, commentaryFloor, commentaryVerdict } from "../src/rag/validate";
import { weightedLength } from "../src/templates/length";

/** Every exemplar's take, in weighted chars — segments after the fact block. */
function takeLengths(): number[] {
  const out: number[] = [];
  for (const e of OWNER_EXEMPLARS) {
    const segs = e.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (segs.length < 2) continue;
    out.push(weightedLength(segs.slice(1).join(" ")));
  }
  return out.sort((a, b) => a - b);
}

describe("the take anchors cannot drift from the data that justifies them", () => {
  it("MIN_TAKE_WEIGHTED IS the owner's shortest signed take", () => {
    // The constant is a literal that happens to equal the data today. Without
    // this, a future exemplar with a 60-char take makes the parity test fail —
    // correctly — and the tempting fix is to lower the constant to 60, which
    // RATCHETS THE FLOOR DOWN permanently, one exemplar at a time. Pinning it
    // means lowering it is a decision someone makes on purpose.
    expect(MIN_TAKE_WEIGHTED).toBe(Math.min(...takeLengths()));
  });

  it("TARGET_TAKE_WEIGHTED IS the owner's median take", () => {
    const t = takeLengths();
    const median = t.length % 2 ? t[(t.length - 1) / 2]! : (t[t.length / 2 - 1]! + t[t.length / 2]!) / 2;
    expect(TARGET_TAKE_WEIGHTED).toBe(median);
  });

  it("the bottom of the distribution is DENSE, which is what defends the minimum", () => {
    // The honest defence of anchoring on the observed minimum. If takes were
    // [75, 120, 124, ...] then 75 is a freak sample and the 10th percentile
    // would be the right anchor. They are not: the gap from min to p10 is
    // small, so the choice barely matters and is not fitted to one point.
    const t = takeLengths();
    const p10 = t[Math.floor(t.length * 0.1)]!;
    expect(p10 - t[0]!).toBeLessThanOrEqual(20);
    expect(t[1]! - t[0]!).toBeLessThanOrEqual(10); // the next value is adjacent
  });

  it("the target is well ABOVE the floor — they are different quantities", () => {
    // If these converged, the prompt's two numbers would collapse into one and
    // the satisficing risk would be back.
    expect(TARGET_TAKE_WEIGHTED).toBeGreaterThan(MIN_TAKE_WEIGHTED * 1.4);
  });
});

describe("a degraded render does not buy a cheap take", () => {
  it("an unmeasurable record is refused, NOT given the permissive default", () => {
    // commentaryFloor("") is MIN_TAKE_WEIGHTED — the loosest answer. Correct
    // as a validator default (a forgotten argument must not cause spurious
    // rejections), wrong as a generation decision, where it would admit a
    // 75-char take against a real record that merely failed to render.
    expect(commentaryFloor("")).toBe(MIN_TAKE_WEIGHTED);
    for (const degraded of ["", "   ", "\n\n", "\n \n\t"]) {
      expect(commentaryVerdict(degraded), JSON.stringify(degraded)).toBe("unmeasurable");
    }
  });

  it("and the two withholding reasons stay distinct", () => {
    expect(commentaryVerdict("8-K, per SEC.")).toBe("ok");
    expect(commentaryVerdict("x".repeat(280))).toBe("no_room");
  });
});
