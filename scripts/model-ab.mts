// Model A/B harness (owner-requested 2026-08-01).
//
// Runs REAL production items through the REAL prompt against several models,
// scores each output with the REAL doctrine validators, and writes a
// blind-labelled comparison for the owner to judge. Nothing here writes to
// D1 or to Telegram; it is read-only against production and costs only
// OpenRouter tokens.
//
// USAGE
//   1. Put the key in .dev.vars at the repo root (gitignored, never committed):
//        OPENROUTER_API_KEY=sk-or-...
//   2. npx tsx scripts/model-ab.mts [itemCount]
//
// The owner judges BLIND: models are labelled A/B/C in the report and the
// key is printed at the bottom, so voice quality is read before the price tag.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { buildPrompt } from "../src/rag/generate";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";
import { parseVariants } from "../src/rag/openrouter";
import {
  payloadFacts,
  numberCheck,
  entityCheck,
  sourcingCheck,
  urlCheck,
  motiveCheck,
  structuralCheck,
  lengthCheck,
  hedgeCheck,
  cadenceCheck,
  type ValidationIssue,
} from "../src/rag/validate";
import { checkRegister } from "../src/templates/validate";
import type { ArchetypeId, Payload } from "../src/templates/types";

/** Candidates. Kept small and current; the point is a judgement, not a survey. */
// Verified against the LIVE OpenRouter catalog 2026-08-01 — never a remembered
// id. A wrong id returns "not a valid model ID" and scores zero, which reads
// like a model failing when it is the harness failing.
const MODELS = [
  "openai/gpt-5.6-terra", // incumbent from 2026-08-01 (see the A/B record)
  "anthropic/claude-sonnet-5",
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3.7-flash", // prior incumbent, kept as the baseline
];

const ITEM_COUNT = Number(process.argv[2] ?? 6);

function apiKey(): string {
  const fromEnv = process.env["OPENROUTER_API_KEY"];
  if (fromEnv) return fromEnv;
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith("OPENROUTER_API_KEY="));
    if (line) return line.slice("OPENROUTER_API_KEY=".length).trim();
  } catch {
    /* fall through */
  }
  console.error(
    "No OPENROUTER_API_KEY. Put it in .dev.vars at the repo root (gitignored):\n  OPENROUTER_API_KEY=sk-or-...",
  );
  process.exit(1);
}

function d1(sql: string): Array<Record<string, unknown>> {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "skeptic-wire", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

/** The doctrine floor, minus the two checks that need D1 (skeleton collision
 *  and corpus echo). Those compare against OUR history, not model quality, so
 *  excluding them keeps the comparison about the thing being compared. */
function scoreDraft(text: string, archetype: ArchetypeId, payload: Payload, variant: "dry" | "sharp" | "commentary"): ValidationIssue[] {
  const facts = payloadFacts(payload);
  return [
    ...numberCheck(text, payload, facts),
    ...entityCheck(text, payload, facts),
    ...sourcingCheck(text),
    ...urlCheck(text),
    ...motiveCheck(text),
    ...structuralCheck(text, variant),
    ...checkRegister(text, archetype, payload),
    ...lengthCheck(text, variant),
    ...hedgeCheck(text),
    ...cadenceCheck(text),
  ];
}

async function callModel(key: string, model: string, system: string, user: string) {
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      // 4000, not 900: reasoning models spend the budget on thinking tokens
      // before emitting anything. At 900, Sonnet 5 returned finish_reason
      // "length" with EMPTY content, which this harness scored as "0 valid
      // drafts" — a harness failure reported as a model failure.
      max_tokens: 4000,
    }),
  });
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
  };
  return {
    ok: res.ok && !json.error,
    error: json.error?.message ?? (res.ok ? null : `HTTP ${res.status}`),
    content: json.choices?.[0]?.message?.content ?? "",
    finish: json.choices?.[0]?.finish_reason ?? null,
    usage: json.usage ?? {},
    ms: Date.now() - started,
  };
}

async function main() {
  const key = apiKey();
  const covered = [...new Set(OWNER_EXEMPLARS.map((e) => e.archetype))];
  console.log(`Exemplar-covered archetypes: ${covered.join(", ")}\n`);

  const rows = d1(
    `SELECT q.id, q.archetype, i.payload FROM queue q JOIN items i ON i.id = q.item_id
     WHERE q.archetype IN (${covered.map((a) => `'${a}'`).join(",")})
     ORDER BY q.id DESC LIMIT ${ITEM_COUNT}`,
  );
  console.log(`Scoring ${rows.length} real items x ${MODELS.length} models.\n`);

  const report: string[] = [
    "# Model A/B — real items, real prompt, real validators",
    "",
    `Generated ${new Date().toISOString()}. ${rows.length} production items, ${MODELS.length} models.`,
    "",
    "Models are labelled A/B/C/D. **Read the drafts before the key at the bottom** —",
    "the point is to judge the voice, not the price tag. Validator results use the",
    "doctrine floor (fabrication, attribution, register, length); the two checks that",
    "compare against our own history are excluded, since they measure us, not the model.",
    "",
  ];
  const label = (i: number) => String.fromCharCode(65 + i);
  const totals = MODELS.map(() => ({ valid: 0, drafts: 0, inTok: 0, outTok: 0, ms: 0, errors: 0 }));

  for (const row of rows) {
    const archetype = row["archetype"] as ArchetypeId;
    const payload = JSON.parse(row["payload"] as string) as Payload;
    const bank = OWNER_EXEMPLARS.filter((e) => e.archetype === archetype);
    const { system, user } = buildPrompt(archetype, payload, bank);
    report.push(`## Item #${row["id"]} — ${archetype}`, "");

    for (let m = 0; m < MODELS.length; m++) {
      const r = await callModel(key, MODELS[m]!, system, user);
      const t = totals[m]!;
      t.ms += r.ms;
      t.inTok += r.usage.prompt_tokens ?? 0;
      t.outTok += r.usage.completion_tokens ?? 0;
      if (!r.ok) {
        t.errors++;
        report.push(`### Model ${label(m)}`, "", `_call failed: ${r.error}_`, "");
        continue;
      }
      const variants = parseVariants(r.content);
      report.push(`### Model ${label(m)}`, "");
      if (!variants.commentary && !variants.sharp && !variants.dry) {
        // Distinguish "the model wrote badly" from "we could not read it".
        report.push(
          `_no parseable variants (finish: ${r.finish}). Raw reply, first 400 chars:_`,
          "", "```", r.content.slice(0, 400), "```", "",
        );
      }
      for (const v of ["commentary", "sharp", "dry"] as const) {
        const text = variants[v];
        if (!text) {
          report.push(`**${v}** — absent from the response`, "");
          continue;
        }
        const issues = scoreDraft(text, archetype, payload, v);
        t.drafts++;
        if (issues.length === 0) t.valid++;
        const verdict = issues.length === 0 ? "PASSES" : `REJECTED: ${issues.map((i) => i.rule).join(", ")}`;
        report.push(`**${v}** — ${verdict}`, "", "```", text, "```", "");
      }
    }
  }

  report.push("---", "", "## Scorecard", "", "| model | drafts valid | tokens in/out | avg latency | call errors |", "|---|---|---|---|---|");
  MODELS.forEach((_, m) => {
    const t = totals[m]!;
    const pct = t.drafts ? Math.round((t.valid / t.drafts) * 100) : 0;
    report.push(
      `| ${label(m)} | ${t.valid}/${t.drafts} (${pct}%) | ${t.inTok}/${t.outTok} | ${Math.round(t.ms / Math.max(1, rows.length))} ms | ${t.errors} |`,
    );
  });
  report.push("", "## Key (read after judging)", "");
  MODELS.forEach((mdl, m) => report.push(`- **${label(m)}** = \`${mdl}\``));
  report.push("", "Pricing is per-model on openrouter.ai/models; token counts above are real.", "");

  const path = new URL("../docs/verification/2026-08-01-model-ab.md", import.meta.url);
  writeFileSync(path, report.join("\n"));
  console.log(`Wrote ${path.pathname}`);
  MODELS.forEach((mdl, m) => {
    const t = totals[m]!;
    console.log(`${label(m)} ${mdl}: ${t.valid}/${t.drafts} valid, ${t.outTok} out-tokens, ${t.errors} errors`);
  });
}

main();
