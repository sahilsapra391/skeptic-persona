import { log } from "../lib/log";

// OpenRouter chat-completions client. Zero dependencies, one endpoint.
//
// Live-verified 2026-07-28 (docs/verification/2026-07-28-openrouter.md):
// POST https://openrouter.ai/api/v1/chat/completions answers unauthenticated
// with HTTP 401 and JSON {"error":{"message":"...","code":401}} — so the
// error envelope is error.code/error.message, and a FULL round-trip
// verification is still owed the moment OPENROUTER_API_KEY exists.
//
// OpenRouter is deliberate (owner decision): model portability over one
// fewer hop. The model id is env config, never code.

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number,
  ) {
    super(`openrouter ${code}: ${message}`);
  }
  /** 401/403 mean the key is bad — alert once, don't retry per tick. */
  get isAuthInvalid(): boolean {
    return this.code === 401 || this.code === 403 || this.httpStatus === 401 || this.httpStatus === 403;
  }
}

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string; code?: number };
}

export async function chatComplete(
  apiKey: string,
  model: string,
  messages: readonly ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter attribution headers (their docs ask; harmless if ignored).
      "HTTP-Referer": "https://skeptic.fyi",
      "X-Title": "Skeptic Wire",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.8,
    }),
    // The LLM call IS the latency floor of the generation job; anything past
    // 60s is a hung upstream, not a slow one.
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  let body: ChatResponse;
  try {
    body = JSON.parse(raw) as ChatResponse;
  } catch {
    throw new OpenRouterError(res.status, `non-JSON response: ${raw.slice(0, 120)}`, res.status);
  }
  if (body.error || !res.ok) {
    throw new OpenRouterError(body.error?.code ?? res.status, body.error?.message ?? "unknown", res.status);
  }
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content === "") {
    throw new OpenRouterError(res.status, "empty completion", res.status);
  }
  // The completeness principle (the House PDF lesson): a truncated reply that
  // still parses is a well-formed lie. finish_reason "length" is the document
  // telling us it was cut off — strictly better than any heuristic, so treat
  // it as a transient failure (retry on cadence), never as a short answer.
  if (choice?.finish_reason === "length") {
    throw new OpenRouterError(res.status, "completion truncated at max_tokens (finish_reason=length)", res.status);
  }
  return content;
}

/**
 * Parse the model's JSON variants defensively: models wrap JSON in prose and
 * code fences no matter how firmly told not to. Missing/non-string variants
 * return as absent rather than throwing — the caller treats absent exactly
 * like validation failure (regenerate once, then fall back).
 */
export function parseVariants(content: string): Partial<Record<"dry" | "sharp" | "commentary", string>> {
  // Layered (finding #23: first-{ to last-} dies when the surrounding prose
  // contains braces, e.g. a preamble echoing the requested format). Extract
  // every BALANCED top-level object, parse each, and keep the one carrying
  // the most variant keys — a decoy like {"dry": "..."} in prose scores 1,
  // the real reply scores 3.
  const keys = ["dry", "sharp", "commentary"] as const;
  const extract = (c: string): Partial<Record<(typeof keys)[number], string>> | null => {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed === null || typeof parsed !== "object") return null;
      const rec = parsed as Record<string, unknown>;
      const out: Partial<Record<(typeof keys)[number], string>> = {};
      for (const k of keys) {
        if (typeof rec[k] === "string" && rec[k].trim() !== "") out[k] = (rec[k] as string).trim();
      }
      return Object.keys(out).length > 0 ? out : null;
    } catch {
      return null;
    }
  };

  const candidates: string[] = [content];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  if (fence?.[1]) candidates.push(fence[1]);
  // Balanced-object scan (string- and escape-aware enough for JSON).
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(content.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  let best: Partial<Record<(typeof keys)[number], string>> = {};
  for (const c of candidates) {
    const got = extract(c);
    if (got && Object.keys(got).length > Object.keys(best).length) best = got;
    if (Object.keys(best).length === keys.length) return best;
  }
  if (Object.keys(best).length > 0) return best;

  // Per-key regex salvage for broken outer JSON; LAST occurrence wins (the
  // real reply follows any prose that echoes the format).
  const out: Partial<Record<(typeof keys)[number], string>> = {};
  for (const k of keys) {
    const matches = [...content.matchAll(new RegExp(`"${k}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, "g"))];
    const m = matches.at(-1);
    if (m?.[1]) {
      try {
        const v: unknown = JSON.parse(m[1]);
        if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
      } catch {
        // leave absent
      }
    }
  }
  if (Object.keys(out).length === 0) log("warn", "openrouter reply carried no parseable variants");
  return out;
}
