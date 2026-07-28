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
  choices?: Array<{ message?: { content?: string } }>;
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
      max_tokens: opts.maxTokens ?? 1024,
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
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content === "") {
    throw new OpenRouterError(res.status, "empty completion", res.status);
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
  const startIdx = content.indexOf("{");
  const endIdx = content.lastIndexOf("}");
  if (startIdx === -1 || endIdx <= startIdx) {
    log("warn", "openrouter reply carried no JSON object");
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(startIdx, endIdx + 1));
  } catch {
    log("warn", "openrouter reply JSON did not parse");
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const rec = parsed as Record<string, unknown>;
  const out: Partial<Record<"dry" | "sharp" | "commentary", string>> = {};
  for (const k of ["dry", "sharp", "commentary"] as const) {
    if (typeof rec[k] === "string" && rec[k].trim() !== "") out[k] = (rec[k] as string).trim();
  }
  return out;
}
