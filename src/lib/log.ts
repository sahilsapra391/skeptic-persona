type Level = "debug" | "info" | "warn" | "error";

// Structured single-line JSON so `wrangler tail` output is grep/jq-able.
export function log(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
