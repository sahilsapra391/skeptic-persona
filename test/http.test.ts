import { fetchMock } from "cloudflare:test";
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
