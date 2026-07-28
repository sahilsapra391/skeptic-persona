import { describe, expect, it } from "vitest";
import { POST_TEXT_LIMIT, fitsInPost, weightedLength } from "../src/templates/length";

// Pins the weighted-length algorithm against twitter-text config v3.
// See docs/verification/2026-07-28-x-post-length.md for the source values.

describe("weightedLength", () => {
  it("counts plain ASCII one-for-one", () => {
    expect(weightedLength("")).toBe(0);
    expect(weightedLength("hello")).toBe(5);
    expect(weightedLength("HALT: STKH. News Pending, 19:50 ET, per Nasdaq")).toBe(46);
  });

  it("bills anything outside the weight-100 ranges at 2 — the CJK case", () => {
    expect(weightedLength("日")).toBe(2);
    expect(weightedLength("日本")).toBe(4);
    // 4351 is the last light code point; 4352 is the first heavy one.
    expect(weightedLength(String.fromCodePoint(4351))).toBe(1);
    expect(weightedLength(String.fromCodePoint(4352))).toBe(2);
  });

  it("keeps the punctuation ranges at 1, including the em-dash and ZWJ", () => {
    expect(weightedLength("—")).toBe(1); // em-dash (banned in copy, but must count right)
    expect(weightedLength("′")).toBe(1); // prime
    expect(weightedLength(" ")).toBe(1); // en quad
  });

  it("counts a country flag as 2, where String.length says 4", () => {
    // The case persona.md §6 actually hits: flags for rate decisions.
    expect("🇮🇳".length).toBe(4);
    expect(weightedLength("🇮🇳")).toBe(2);
    expect(weightedLength("🇮🇳🇺🇸")).toBe(4);
    expect(weightedLength("Repo rate held at 6.5%, per RBI 🇮🇳")).toBe(34); // 32 ASCII + one flag
  });

  it("counts the permitted tape emoji as 2", () => {
    expect(weightedLength("🟢")).toBe(2);
    expect(weightedLength("🔴")).toBe(2);
  });

  it("collapses ZWJ sequences and attaching modifiers to a single emoji", () => {
    expect(weightedLength("👨‍👩‍👧‍👦")).toBe(2); // four people, three ZWJs
    expect(weightedLength("❤️")).toBe(2); // base + VS16
    expect(weightedLength("👍🏽")).toBe(2); // base + skin tone
  });

  it("bills any URL at 23 regardless of real length", () => {
    expect(weightedLength("https://x.co/a")).toBe(23);
    expect(weightedLength(`https://www.sec.gov/Archives/${"a".repeat(200)}`)).toBe(23);
    expect(weightedLength("see https://x.co/a now")).toBe(4 + 23 + 4); // "see " + url + " now"
  });

  it("normalises to NFC before counting", () => {
    const composed = "é"; // é
    const decomposed = "é"; // e + combining acute
    expect(decomposed.length).toBe(2);
    expect(weightedLength(composed)).toBe(1);
    expect(weightedLength(decomposed)).toBe(1);
  });

  it("over-counts rather than under-counts when a cluster is unrecognised", () => {
    // The safety property. Cluster detection is partial by design, so an
    // unrecognised emoji is counted per code point. That can waste a little
    // budget; it can never let an over-long post through.
    const lone = "\u{1F1EE}"; // a single regional indicator, not a flag
    expect(weightedLength(lone)).toBeGreaterThanOrEqual(2);
  });

  it("fitsInPost draws the line at exactly 280 weighted characters", () => {
    expect(fitsInPost("x".repeat(POST_TEXT_LIMIT))).toBe(true);
    expect(fitsInPost("x".repeat(POST_TEXT_LIMIT + 1))).toBe(false);
    // 140 CJK characters is the real ceiling for a post in Japanese.
    expect(fitsInPost("日".repeat(140))).toBe(true);
    expect(fitsInPost("日".repeat(141))).toBe(false);
  });

  it("String.length would have been wrong in BOTH directions", () => {
    // Under-counts: 141 CJK chars pass a naive check and X rejects them.
    const cjk = "日".repeat(141);
    expect(cjk.length).toBeLessThanOrEqual(POST_TEXT_LIMIT);
    expect(fitsInPost(cjk)).toBe(false);

    // Over-counts: 70 flags are 280 to JS but only 140 to X, so a naive check
    // would have refused a publishable post.
    const flags = "🇮🇳".repeat(70);
    expect(flags.length).toBe(280);
    expect(weightedLength(flags)).toBe(140);
    expect(fitsInPost(flags)).toBe(true);
  });
});
