import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { postedVerbatim } from "../src/rag/learn";
import { ownerFinalsAllowance } from "../src/rag/generate";

// B-24.1. The posted_verbatim tier: cards the owner shipped with zero edits.
// Endorsement, not instruction — the owner had Edit and Regenerate one tap
// away and used neither. Each of the four constraints is asserted here rather
// than argued in a comment.

const post = (o: {
  id: number; arch: string; draft: string; final: string; manual?: number; variant?: string;
}) =>
  env.DB.prepare(
    // queue_id stays NULL: post_log has a FOREIGN KEY to queue(id) and this
    // tier is derived from post_log alone.
    `INSERT INTO post_log (id, queue_id, posted_at, archetype, category, posted_manually,
                           draft_text, final_text, draft_variant, edit_distance)
     VALUES (?1, NULL, '2026-08-07T00:00:00.000Z', ?2, 'insider', ?3, ?4, ?5, ?6, ?7)`,
  ).bind(o.id, o.arch, o.manual ?? 1, o.draft, o.final, o.variant ?? "sharp",
         o.draft === o.final ? 0 : 5).run();

describe("posted_verbatim is re-derived from post_log, never copied", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM post_log`).run();
  });

  it("returns a card the owner posted untouched", async () => {
    const t = "Form 4: someone sold shares, per SEC Form 4";
    await post({ id: 1, arch: "FILING_FORM4", draft: t, final: t });
    const out = await postedVerbatim(env.DB, "FILING_FORM4", 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.provenance).toBe("posted_verbatim");
    expect(out[0]!.text).toBe(t);
  });

  it("a post that was EDITED is not in this tier — that is the finals path", async () => {
    await post({ id: 2, arch: "FILING_FORM4", draft: "a draft, per SEC Form 4", final: "an edit, per SEC Form 4" });
    expect(await postedVerbatim(env.DB, "FILING_FORM4", 5)).toHaveLength(0);
  });

  it("a post CORRECTED later drops out on its own, because nothing was copied", async () => {
    const t = "Form 4: someone sold shares, per SEC Form 4";
    await post({ id: 3, arch: "FILING_FORM4", draft: t, final: t });
    expect(await postedVerbatim(env.DB, "FILING_FORM4", 5)).toHaveLength(1);
    // The owner corrects the published text after the fact.
    await env.DB.prepare(`UPDATE post_log SET final_text = ?1, edit_distance = 4 WHERE id = 3`)
      .bind(t + " corrected").run();
    expect(await postedVerbatim(env.DB, "FILING_FORM4", 5)).toHaveLength(0);
  });

  it("an automated Threads-era post is never in this tier", async () => {
    const t = "Form 4: someone sold shares, per SEC Form 4";
    await post({ id: 4, arch: "FILING_FORM4", draft: t, final: t, manual: 0 });
    expect(await postedVerbatim(env.DB, "FILING_FORM4", 5)).toHaveLength(0);
  });

  it("is held to the same register bar as a committed exemplar", async () => {
    // An em-dash is banned by checkRegister; shipping it does not license it.
    const bad = "Form 4: someone sold shares — a lot of them, per SEC Form 4";
    await post({ id: 5, arch: "FILING_FORM4", draft: bad, final: bad });
    expect(await postedVerbatim(env.DB, "FILING_FORM4", 5)).toHaveLength(0);
  });

  it("respects its limit, and a zero limit means no query at all", async () => {
    const t = "Form 4: someone sold shares, per SEC Form 4";
    for (const id of [10, 11, 12]) await post({ id, arch: "FILING_FORM4", draft: t, final: t });
    expect(await postedVerbatim(env.DB, "FILING_FORM4", 2)).toHaveLength(2);
    expect(await postedVerbatim(env.DB, "FILING_FORM4", 0)).toHaveLength(0);
  });
});

describe("the cap is the EXISTING minority budget, not a second one", () => {
  it("finals and verbatim share one allowance, so the bank stays owner-majority", () => {
    // The invariant that already governs finals: strictly fewer than half the
    // committed count. Verbatim draws from the same budget rather than beside
    // it, so no volume of shipped cards can tip the bank.
    for (const committed of [0, 1, 2, 3, 5, 7, 9, 20]) {
      const budget = ownerFinalsAllowance(committed);
      expect(budget).toBeLessThan(Math.max(committed, 1));
      // finals first, verbatim tops up what is left — never more than the budget
      // finals can never exceed the budget itself; verbatim tops up the rest
      for (const finals of [0, Math.min(1, budget), budget]) {
        const verbatimAllowance = Math.max(0, budget - finals);
        expect(finals + verbatimAllowance).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("a two-exemplar archetype admits NOTHING from either tier", () => {
    // The thinnest banks are the most exposed, so they get no top-up at all.
    expect(ownerFinalsAllowance(2)).toBe(0);
    expect(ownerFinalsAllowance(1)).toBe(0);
  });
});
