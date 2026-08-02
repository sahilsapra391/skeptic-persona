import { describe, expect, it } from "vitest";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";
import { MIN_TAKE_WEIGHTED, TARGET_TAKE_WEIGHTED, commentaryFloor, commentaryVerdict, lengthCheck } from "../src/rag/validate";
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

describe("an owner edit cannot lower the floor", () => {
  // The reachable gap, traced by review: `fallback` is `edited_text ??
  // draft_text`, re-rendered ONLY when it fails fitsInPost — and the register
  // check runs later, at the fallback stage. So an owner edit that FITS THE
  // BUDGET BUT FAILS THE REGISTER slips between the two gates and would have
  // become the floor anchor, with its first line being whatever he typed.
  //
  // The harmful direction is a SHORTER first line: floor drops, thin
  // commentary is admitted against an item whose record is real.
  const CANONICAL = "8-K, Item 4.02: prior financial statements for fiscal 2025 should no longer be relied upon, filed after the close, per SEC.";
  const OWNER_EDIT_SHORT_FIRST_LINE = "Non-reliance.\n\n8-K item 4.02, per SEC.";

  it("the canonical render sets a materially higher floor than a short edit", () => {
    expect(commentaryFloor(CANONICAL)).toBeGreaterThan(commentaryFloor(OWNER_EDIT_SHORT_FIRST_LINE) + 50);
  });

  it("lengthCheck reads floorAnchor, not templateDraft, when both are given", () => {
    // A take that would pass against the owner's short line must still fail
    // against the record's own fact block.
    const thin = `${CANONICAL}\n\nRelied upon until it wasn't.`;
    expect(
      lengthCheck(thin, "commentary", OWNER_EDIT_SHORT_FIRST_LINE),
      "against the owner edit as anchor: passes, which is the bug",
    ).toEqual([]);
    expect(
      lengthCheck(thin, "commentary", CANONICAL).map((i) => i.rule),
      "against the canonical render: rejected, which is correct",
    ).toEqual(["length"]);
  });

  it("the two fields answer different questions and must not be merged again", () => {
    // templateDraft = what must not be echoed (the text that would post).
    // floorAnchor  = what the record supports (the template render).
    // They briefly shared one field, which is the mutable-slot shape all over
    // again: one value, two readers, different correct answers.
    expect(commentaryFloor(CANONICAL)).not.toBe(commentaryFloor(OWNER_EDIT_SHORT_FIRST_LINE));
  });
});

describe("the two withholding reasons keep separate faces", () => {
  it("a product outcome and a defect do not read the same to the owner", async () => {
    // They had separate rows in D1 and one face in Telegram. deliver.ts
    // labelled only skipped_no_exemplar specially; everything else read
    // "generation fell back", so a thin record (correct, nothing wrong) and a
    // degraded render (a defect) were indistinguishable — the null-versus-zero
    // collapse avoided in the data, reappearing in the presentation.
    const { buildCard } = await import("../src/rag/deliver");
    const { env } = await import("cloudflare:test");
    const { insertItem, createQueueEntry, decideQueueEntry, SCORE_POSTABLE } = await import("../src/lib/db");
    const { iso } = await import("../src/lib/time");
    const NOW = new Date("2026-08-02T16:00:00Z");

    const mk = async (ext: string, status: string): Promise<string> => {
      const item = await insertItem(env.DB, {
        source: "senate_ptr", externalId: ext, category: "congress", eventAt: iso(NOW),
        sourceUrl: `https://efdsearch.senate.gov/${ext}`,
        payload: { member: "Jane Roe" }, score: SCORE_POSTABLE,
      });
      const qid = await createQueueEntry(env.DB, item.id ?? 0, "CONGRESS_PTR", "Draft, per Senate eFD", NOW);
      await decideQueueEntry(env.DB, qid, "approved", NOW);
      const card = await buildCard(env.DB, qid, "CONGRESS_PTR", status, 1);
      return card.text;
    };

    const thin = await mk("lbl-thin", "skipped_record_too_thin");
    const bad = await mk("lbl-bad", "skipped_record_unmeasurable");
    const plain = await mk("lbl-plain", "fallback_template");

    expect(thin).toContain("cannot fund a take");
    expect(bad).toContain("a defect, not a thin record");
    expect(plain).toContain("generation fell back");
    // The one that matters: they are not the same string.
    expect(thin).not.toBe(bad);
  });
});
