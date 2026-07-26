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
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

export interface PoliteOptions {
  userAgent: string;
  timeoutMs?: number;
  validators?: HttpValidators;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  postBody?: string;
}

export function buildUserAgent(contactEmail: string): string {
  // SEC's documented sample is "Sample Company Name AdminContact@<domain>.com".
  return `Skeptic Wire ${contactEmail}`;
}

export async function politeFetch(url: string, opts: PoliteOptions): Promise<PoliteResponse> {
  const headers: Record<string, string> = {
    "User-Agent": opts.userAgent,
    "Accept-Encoding": "gzip, deflate",
    ...opts.headers,
  };
  if (opts.validators?.etag) headers["If-None-Match"] = opts.validators.etag;
  if (opts.validators?.lastModified) headers["If-Modified-Since"] = opts.validators.lastModified;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.postBody,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  const notModified = res.status === 304;
  return {
    status: res.status,
    ok: res.ok,
    notModified,
    body: notModified ? "" : await res.text(),
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    contentType: res.headers.get("content-type"),
  };
}
