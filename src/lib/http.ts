// Polite HTTP for primary-source polling.
// Verified constraints this file encodes (docs/verification/):
// - SEC requires a declared "Name contact@domain" User-Agent, max 10 req/s.
// - BLS 403s default/non-identifying user agents.
// - Several sources serve wrong Content-Type headers (EDGAR Atom/JSON as
//   text/html) — callers parse by body, so we return raw text and never gate
//   on content type.
// - ETag/Last-Modified support varies; conditional GET when the caller has
//   stored validators (source_state), full GET otherwise.

export interface HttpValidators {
  etag?: string | null;
  lastModified?: string | null;
}

export interface PoliteResponse {
  status: number;
  ok: boolean;
  notModified: boolean;
  body: string;
  /** Raw bytes; populated only when the request set binary: true. */
  bodyBytes: Uint8Array | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  /** All Set-Cookie headers (session handshakes: Senate eFD). */
  setCookies: string[];
}

export interface PoliteOptions {
  userAgent: string;
  timeoutMs?: number;
  validators?: HttpValidators;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  postBody?: string;
  /** "manual" surfaces 30x responses (their Set-Cookie matters mid-handshake). */
  redirect?: "follow" | "manual";
  /** Read the body as bytes (ZIP archives) instead of text. */
  binary?: boolean;
  cookie?: string;
}

export function buildUserAgent(contactEmail: string): string {
  // SEC's documented sample is "Sample Company Name AdminContact@<domain>.com".
  return `Skeptic Wire ${contactEmail}`;
}

// Error contract: politeFetch RETURNS non-2xx responses (callers check .ok /
// .status — a BLS 403 is data, not an exception) but THROWS on network
// failures and timeouts (AbortSignal.timeout). Ingesters wrap calls in
// try/catch and count failures in source_state.

export async function politeFetch(url: string, opts: PoliteOptions): Promise<PoliteResponse> {
  // NOTE: no manual Accept-Encoding. Setting it explicitly tells the Workers
  // runtime we intend to handle content-coding ourselves, which can hand back
  // an undecoded body; the runtime negotiates and decompresses transparently
  // when we stay out of the way.
  const headers: Record<string, string> = {
    "User-Agent": opts.userAgent,
    ...opts.headers,
  };
  if (opts.validators?.etag) headers["If-None-Match"] = opts.validators.etag;
  if (opts.validators?.lastModified) headers["If-Modified-Since"] = opts.validators.lastModified;
  if (opts.cookie) headers["Cookie"] = opts.cookie;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.postBody,
    redirect: opts.redirect ?? "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  const notModified = res.status === 304;
  const wantBody = !notModified && opts.binary !== true;
  return {
    status: res.status,
    ok: res.ok,
    notModified,
    body: wantBody ? await res.text() : "",
    bodyBytes: !notModified && opts.binary === true ? new Uint8Array(await res.arrayBuffer()) : null,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    contentType: res.headers.get("content-type"),
    setCookies: res.headers.getSetCookie?.() ?? [],
  };
}
