import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildUserAgent, politeFetch } from "../src/lib/http";

const UA = buildUserAgent("admin@spechawk.ai");

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe("politeFetch", () => {
  it("sends the declared User-Agent and returns the body even when Content-Type lies", async () => {
    // EDGAR serves Atom XML as text/html — verified 2026-07-26.
    fetchMock
      .get("https://www.sec.gov")
      .intercept({ path: "/feed", headers: { "user-agent": UA } })
      .reply(200, "<feed><entry/></feed>", { headers: { "content-type": "text/html; charset=utf-8" } });

    const res = await politeFetch("https://www.sec.gov/feed", { userAgent: UA });
    expect(res.ok).toBe(true);
    expect(res.notModified).toBe(false);
    expect(res.body).toBe("<feed><entry/></feed>");
    expect(res.contentType).toContain("text/html");
  });

  it("does conditional GET with stored validators and handles 304", async () => {
    fetchMock
      .get("https://disclosures-clerk.house.gov")
      .intercept({
        path: "/public_disc/financial-pdfs/2026FD.zip",
        headers: { "if-none-match": 'W/"abc"', "if-modified-since": "Fri, 24 Jul 2026 13:00:40 GMT" },
      })
      .reply(304, "", { headers: { etag: 'W/"abc"' } });

    const res = await politeFetch("https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip", {
      userAgent: UA,
      validators: { etag: 'W/"abc"', lastModified: "Fri, 24 Jul 2026 13:00:40 GMT" },
    });
    expect(res.notModified).toBe(true);
    expect(res.body).toBe("");
    expect(res.etag).toBe('W/"abc"');
  });

  it("captures fresh validators from responses", async () => {
    fetchMock
      .get("https://www.federalreserve.gov")
      .intercept({ path: "/feeds/press_all.xml" })
      .reply(200, "<rss/>", {
        headers: { etag: '"v2"', "last-modified": "Thu, 16 Jul 2026 18:00:15 GMT", "content-type": "text/xml" },
      });

    const res = await politeFetch("https://www.federalreserve.gov/feeds/press_all.xml", { userAgent: UA });
    expect(res.etag).toBe('"v2"');
    expect(res.lastModified).toBe("Thu, 16 Jul 2026 18:00:15 GMT");
  });

  it("surfaces non-2xx statuses without throwing (BLS 403 path)", async () => {
    fetchMock.get("https://www.bls.gov").intercept({ path: "/news.release/cpi.nr0.htm" }).reply(403, "blocked");
    const res = await politeFetch("https://www.bls.gov/news.release/cpi.nr0.htm", { userAgent: UA });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.body).toBe("blocked");
  });

  it("sends no conditional headers when there are no stored validators", async () => {
    let captured: unknown;
    fetchMock
      .get("https://plain.example")
      .intercept({ path: "/x" })
      .reply(200, (opts: { headers: unknown }) => {
        captured = opts.headers;
        return "ok";
      });

    await politeFetch("https://plain.example/x", { userAgent: UA });

    const keys = Array.isArray(captured)
      ? (captured as string[]).filter((_, i) => i % 2 === 0)
      : Object.keys((captured as Record<string, string>) ?? {});
    const lower = keys.map((k) => k.toLowerCase());
    expect(lower).not.toContain("if-none-match");
    expect(lower).not.toContain("if-modified-since");
  });

  it("passes POST method and body through (Senate eFD handshake shape)", async () => {
    fetchMock
      .get("https://efdsearch.senate.gov")
      .intercept({ path: "/search/report/data/", method: "POST", body: "start=0&length=10" })
      .reply(200, `{"result":"ok"}`);

    const res = await politeFetch("https://efdsearch.senate.gov/search/report/data/", {
      userAgent: UA,
      method: "POST",
      postBody: "start=0&length=10",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.ok).toBe(true);
    expect(res.body).toBe(`{"result":"ok"}`);
  });

  it("rejects when the timeout elapses", async () => {
    fetchMock.get("https://slow.example").intercept({ path: "/hang" }).reply(200, "late").delay(500);
    await expect(politeFetch("https://slow.example/hang", { userAgent: UA, timeoutMs: 50 })).rejects.toThrow();
  });
});

describe("/admin/probe: does Worker egress reach this host?", () => {
  it("refuses without the admin key", async () => {
    const { handleProbe } = await import("../src/admin");
    const res = await handleProbe(
      new Request("https://x/admin/probe", { method: "POST", body: JSON.stringify({ urls: ["https://example.gov/"] }) }),
      env as never,
    );
    expect(res.status).toBe(401);
  });

  it("is https-only and bounded, because a probe that fetches anything is a proxy", async () => {
    const { handleProbe } = await import("../src/admin");
    const call = async (body: unknown) =>
      handleProbe(
        new Request("https://x/admin/probe", {
          method: "POST",
          headers: { "X-Admin-Key": (env as { ADMIN_PROBE_TOKEN?: string }).ADMIN_PROBE_TOKEN as string },
          body: JSON.stringify(body),
        }),
        env as never,
      );
    expect((await call({ urls: [] })).status).toBe(400);
    expect((await call({ urls: Array.from({ length: 11 }, () => "https://example.gov/") })).status).toBe(400);
    const mixed = await (await call({ urls: ["http://www.sec.gov/", "not a url", 7] })).json<{
      results: Array<{ error?: string }>;
    }>();
    expect(mixed.results.map((r) => r.error)).toEqual(["https only", "unparseable", "not a string"]);
  });

  it("B-01.2: refuses hosts that are not in the source registry", async () => {
    // The endpoint answers "does Worker egress reach this host?". Unrestricted,
    // it answers that for ANY host, which makes it an egress proxy wearing a
    // diagnostic's clothes. Adding a host means putting it in the registry
    // first — that ordering is the point.
    const { handleProbe } = await import("../src/admin");
    const res = await handleProbe(
      new Request("https://x/admin/probe", {
        method: "POST",
        headers: { "X-Admin-Key": (env as { ADMIN_PROBE_TOKEN?: string }).ADMIN_PROBE_TOKEN as string },
        body: JSON.stringify({ urls: ["https://evil.example.com/", "https://notsec.gov/", "https://data.sec.gov/x"] }),
      }),
      env as never,
    );
    const body = await res.json<{ results: Array<{ error?: string; url: string }> }>();
    expect(body.results[0]!.error).toContain("not in the source registry");
    // Suffix matching must not be fooled by a lookalike domain.
    expect(body.results[1]!.error).toContain("not in the source registry");
    // A real registry host passes the allowlist (it then fails to fetch in
    // this harness, which is fine — the allowlist is what is under test).
    expect(body.results[2]!.error ?? "").not.toContain("not in the source registry");
  });

  it("returns status and shape, never the response body", async () => {
    // The point is reachability, not relaying content through the Worker.
    const { handleProbe } = await import("../src/admin");
    fetchMock.activate();
    fetchMock.get("https://www.globenewswire.com").intercept({ path: "/rss" }).reply(200, "<rss><item/></rss>", {
      headers: { "content-type": "application/rss+xml" },
    });
    const res = await handleProbe(
      new Request("https://x/admin/probe", {
        method: "POST",
        headers: { "X-Admin-Key": (env as { ADMIN_PROBE_TOKEN?: string }).ADMIN_PROBE_TOKEN as string },
        body: JSON.stringify({ urls: ["https://www.globenewswire.com/rss"] }),
      }),
      env as never,
    );
    const body = await res.json<{ egress: string; results: Array<Record<string, unknown>> }>();
    expect(body.egress).toBe("cloudflare-worker");
    expect(body.results[0]).toMatchObject({ status: 200, ok: true, contentType: "application/rss+xml" });
    expect(JSON.stringify(body)).not.toContain("<rss>");
  });
});
