// Replay the salience scorer over items already in production D1 and report
// what the queue WOULD have looked like. The p4-03 acceptance gate: no
// curation layer ships on a guess about its own effect.
//
//   node scripts/replay-salience.mjs [days]
//
// Read-only. Runs the scorer through wrangler's remote SELECT, so it scores
// exactly the payloads production holds. Compile the TS scorer first:
//   npx tsx scripts/replay-salience.mjs
import { execFileSync } from "node:child_process";
import {
  salienceFor,
  DEFAULT_SALIENCE_FLOOR,
  DEFAULT_CATEGORY_CAPS,
  DEFAULT_CATEGORY_CAP,
  DEFAULT_CAP_BYPASS_SCORE,
  CEILING_EXEMPT,
} from "../src/salience.ts";

const days = Number(process.argv[2] ?? 2);
const floor = Number(process.env.SALIENCE_FLOOR ?? DEFAULT_SALIENCE_FLOOR);
const bypass = Number(process.env.CAP_BYPASS_SCORE ?? DEFAULT_CAP_BYPASS_SCORE);

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "skeptic-wire", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

// Every card actually created in the window, with the payload that produced it.
const rows = d1(
  `SELECT q.id, q.archetype, q.created_at, i.payload,
          CASE WHEN q.state IN ('approved','edited')
                 OR EXISTS(SELECT 1 FROM post_log p WHERE p.queue_id = q.id)
               THEN 1 ELSE 0 END AS approved
   FROM queue q JOIN items i ON i.id = q.item_id
   WHERE q.created_at >= datetime('now', '-${days} days')
   ORDER BY q.created_at ASC`,
);

const byDay = new Map();
const stats = new Map();
let pushed = 0;
let heldFloor = 0;
let heldCap = 0;
const approvedHeld = [];

for (const r of rows) {
  let payload;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    continue;
  }
  const day = r.created_at.slice(0, 10);
  const { score, exempt } = salienceFor(r.archetype, payload);
  const key = `${day}|${r.archetype}`;
  const seen = byDay.get(key) ?? 0;
  const cap = DEFAULT_CATEGORY_CAPS[r.archetype] ?? DEFAULT_CATEGORY_CAP;

  let outcome;
  if (!exempt && score < floor) outcome = "held:floor";
  else if (!exempt && score < bypass && seen >= cap) outcome = "held:cap";
  else outcome = "push";

  if (outcome === "push") {
    byDay.set(key, seen + 1);
    pushed++;
  } else if (outcome === "held:floor") heldFloor++;
  else heldCap++;

  // The metric that matters most: would we have hidden something he approved?
  if (r.approved === 1 && outcome !== "push") approvedHeld.push({ id: r.id, archetype: r.archetype, score, outcome });

  const s = stats.get(r.archetype) ?? { cards: 0, push: 0, floor: 0, cap: 0, approved: 0, scores: [] };
  s.cards++;
  s.scores.push(score);
  if (outcome === "push") s.push++;
  else if (outcome === "held:floor") s.floor++;
  else s.cap++;
  if (r.approved === 1) s.approved++;
  stats.set(r.archetype, s);
}

const dayCount = new Set(rows.map((r) => r.created_at.slice(0, 10))).size || 1;
console.log(`\nSALIENCE REPLAY — ${rows.length} cards over ${dayCount} day(s), floor=${floor}\n`);
console.log("archetype              cards   push   held(floor/cap)   approved   median");
console.log("-".repeat(78));
for (const [arch, s] of [...stats.entries()].sort((a, b) => b[1].cards - a[1].cards)) {
  const med = s.scores.sort((a, b) => a - b)[Math.floor(s.scores.length / 2)];
  const ex = CEILING_EXEMPT.has(arch) ? " *exempt" : "";
  console.log(
    `${arch.padEnd(22)} ${String(s.cards).padStart(5)}  ${String(s.push).padStart(5)}   ${String(s.floor).padStart(5)}/${String(s.cap).padEnd(5)}   ${String(s.approved).padStart(6)}   ${String(med).padStart(4)}${ex}`,
  );
}
console.log("-".repeat(78));
console.log(`TOTAL                  ${String(rows.length).padStart(5)}  ${String(pushed).padStart(5)}   ${String(heldFloor).padStart(5)}/${String(heldCap).padEnd(5)}`);
console.log(`\nPer day: ${(rows.length / dayCount).toFixed(1)} today -> ${(pushed / dayCount).toFixed(1)} after curation (target 25)`);
console.log(`Reduction: ${(100 - (pushed / rows.length) * 100).toFixed(1)}%`);
console.log(`\nAPPROVED-BUT-HELD (the false-negative that matters): ${approvedHeld.length}`);
for (const a of approvedHeld) console.log(`   queue #${a.id} ${a.archetype} score=${a.score} ${a.outcome}`);
console.log("");
