import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_POSTS_PER_RUN,
  SOURCE,
  WATCH_TERMS,
  isEnabled,
  parseSearchPosts,
  permalink,
  pollBluesky,
} from "../src/ingesters/bluesky";
import { SCORE_LOG_ONLY } from "../src/lib/db";

// Shape captured live 2026-08-07 from app.bsky.feed.searchPosts.
const SEARCH = JSON.stringify({
  posts: [
    {
      uri: "at://did:plc:abc123/app.bsky.feed.post/3kxyz",
      cid: "bafyrei",
      author: { handle: "someone.bsky.social", displayName: "Someone" },
      record: { text: "8-K filed by an issuer this morning", createdAt: "2026-08-07T12:00:00.000Z" },
    },
    // Missing text: dropped rather than stored as an empty signal.
    { uri: "at://did:plc:def/app.bsky.feed.post/3kabc", author: { handle: "x.bsky.social" }, record: {} },
  ],
});

describe("p5-25 Bluesky: discovery only, and off by default", () => {
  it("is OFF unless the flag is exactly 'true'", () => {
    expect(isEnabled({} as never)).toBe(false);
    expect(isEnabled({ BLUESKY_ENABLED: "false" } as never)).toBe(false);
    expect(isEnabled({ BLUESKY_ENABLED: "1" } as never)).toBe(false);
    expect(isEnabled({ BLUESKY_ENABLED: "TRUE" } as never)).toBe(false);
    expect(isEnabled({ BLUESKY_ENABLED: "true" } as never)).toBe(true);
  });

  it("does NOTHING when disabled, including no credential read", async () => {
    // The lane must be inert behind the flag, not merely quiet: a disabled
    // lane that still authenticates would burn a credential and a request.
    //
    // THE DISABLED ENV IS CONSTRUCTED, NEVER ASSUMED. Reading ambient `env`
    // made this assertion depend on wrangler.toml: the moment the owner
    // authorised BLUESKY_ENABLED="true" the flag arrived in the test env, this
    // test polled Bluesky FOR REAL and inserted 121 rows, and it reported the
    // failure as a broken lane rather than a broken test. Exactly the D-6
    // shape. A test that asserts a precondition has to establish it.
    const disabled = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
      BLUESKY_ENABLED: "false",
    });
    const before = await env.DB.prepare(`SELECT COUNT(*) n FROM items WHERE source = ?1`).bind(SOURCE).first<{ n: number }>();
    const n = await pollBluesky(disabled as never, new Date("2026-08-07T12:00:00Z"));
    expect(n).toBe(0);
    const after = await env.DB.prepare(`SELECT COUNT(*) n FROM items WHERE source = ?1`).bind(SOURCE).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    // And absent means off, same as "false".
    const unset = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { BLUESKY_ENABLED: undefined });
    expect(await pollBluesky(unset as never, new Date("2026-08-07T12:00:00Z"))).toBe(0);
  });

  it("parses the live response shape and drops incomplete posts", () => {
    const posts = parseSearchPosts(SEARCH);
    expect(posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      uri: "at://did:plc:abc123/app.bsky.feed.post/3kxyz",
      handle: "someone.bsky.social",
      text: "8-K filed by an issuer this morning",
      createdAt: "2026-08-07T12:00:00.000Z",
    });
  });

  it("survives garbage without throwing", () => {
    expect(parseSearchPosts("not json")).toEqual([]);
    expect(parseSearchPosts("{}")).toEqual([]);
    expect(parseSearchPosts(JSON.stringify({ posts: "nope" }))).toEqual([]);
  });

  it("builds the public permalink from the at:// uri", () => {
    expect(permalink("at://did:plc:abc123/app.bsky.feed.post/3kxyz", "someone.bsky.social")).toBe(
      "https://bsky.app/profile/someone.bsky.social/post/3kxyz",
    );
  });

  it("THE LANE CANNOT CARD: log-only is unconditional in the source", async () => {
    // The p4 mesh rule is that social is DISCOVERY, never citation. That has
    // to hold by construction, not by a branch someone can later add an else
    // to, so this asserts there is exactly one score in the file and no
    // enqueue call at all.
    const src = await import("../src/ingesters/bluesky?raw").then((m) => (m as { default: string }).default);
    expect(src).toContain("SCORE_LOG_ONLY");
    expect(src).not.toContain("SCORE_POSTABLE");
    expect(src).not.toContain("SCORE_AUTO_ALERT");
    expect(src).not.toContain("enqueueForApproval");
    // And no archetype, because there is nothing for one to render. Checked
    // as CODE, not as the word: the header comment says "there is no archetype
    // here", and a bare substring test flagged that explanation as the
    // violation it was describing.
    expect(src).not.toContain("ArchetypeId");
    expect(src).not.toMatch(/\barchetype\s*:/);
    expect(SCORE_LOG_ONLY).toBeLessThan(2);
  });

  it("D-87: points at the AppView host that actually answers", async () => {
    // The first live run failed with `searchPosts 403` and it looked like an
    // authorization requirement. It was the hostname. Measured unauthenticated:
    //   public.api.bsky.app  403 (an HTML Forbidden PAGE, a CDN block)
    //   api.bsky.app         200, 25 posts
    //   bsky.social          401 AuthMissing
    const src = await import("../src/ingesters/bluesky?raw").then((m) => (m as { default: string }).default);
    expect(src).toContain('const APPVIEW = "https://api.bsky.app"');
    expect(src).not.toContain("public.api.bsky.app/xrpc");
  });

  it("D-87: a credential failure must NOT take the lane down", async () => {
    // Search answers anonymously, so the session is best effort. Requiring it
    // would trade a working lane for an unmeasured rate-limit benefit.
    const src = await import("../src/ingesters/bluesky?raw").then((m) => (m as { default: string }).default);
    const poll = src.slice(src.indexOf("export async function pollBluesky"));
    // The session call is wrapped, and the failure path logs and continues.
    expect(poll).toMatch(/try\s*\{[\s\S]{0,200}?await session\(env\)/);
    expect(poll).toContain("polling anonymously");
  });

  it("watch terms name DOCUMENTS, not tickers or topics", () => {
    // A cashtag would drag in the whole retail timeline and teach the lake
    // nothing. The lane's only job is to notice a primary document may exist.
    expect(WATCH_TERMS.length).toBeGreaterThan(0);
    for (const t of WATCH_TERMS) {
      expect(t, `"${t}" looks like a ticker`).not.toMatch(/^\$/);
      expect(t.length).toBeGreaterThan(4);
    }
    expect(MAX_POSTS_PER_RUN).toBeLessThanOrEqual(25);
  });
});
