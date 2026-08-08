#!/usr/bin/env node
// B-18.1: the governance gate that CI runs UNCONDITIONALLY.
//
// Why a script and not just the vitest suite: ci.yml classifies a change whose
// every path matches `docs/*.md` or `*.md` as docs-only and skips `npm test`.
// Every governance file matches that pattern. A PR that empties CLAUDE.md is
// therefore classified docs-only and never runs the suite that guards it —
// which is precisely how 6,835 bytes went to 0 and merged with a green tick.
//
// So this runs with no `npm ci`, no node_modules and no `if:` condition. It
// needs nothing but node and the checkout, which is what lets it sit before
// the expensive steps and still cost nothing on a docs-only PR.
//
// The vitest suite reads the SAME manifest, so the two cannot drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "docs/governance.manifest.json"), "utf8"));

const failures = [];
const contents = new Map();

for (const spec of manifest.files) {
  let body;
  try {
    body = readFileSync(join(root, spec.path), "utf8");
  } catch (e) {
    failures.push(`${spec.path}: UNREADABLE (${e.code ?? e.message})`);
    continue;
  }
  contents.set(spec.path, body);

  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes === 0) {
    failures.push(`${spec.path}: EMPTY (0 bytes)`);
    continue;
  }
  if (bytes < spec.minBytes) {
    failures.push(`${spec.path}: ${bytes} bytes, below the ${spec.minBytes} floor — truncated?`);
  }
  for (const anchor of spec.anchors) {
    if (!body.includes(anchor)) failures.push(`${spec.path}: missing required section ${JSON.stringify(anchor)}`);
  }
}

// Named rules, asserted BY NAME in the file each actually lives in.
for (const fp of manifest.fingerprint) {
  const body = contents.get(fp.file);
  if (body === undefined) continue; // already reported as unreadable above
  if (!body.includes(fp.contains)) {
    failures.push(`${fp.file}: fingerprint lost — "${fp.name}" is no longer present`);
  }
}

// D-101 (B-19.4): no two ledger rows may answer to the same D-number.
//
// This is the check that caught my own cascade — renumbering D-92->93, 93->94,
// 94->95 as a LOOP over every row rewrote each row three times and collapsed
// all of them onto D-95. It is permanent because five separate collisions
// happened while two sessions appended to one ledger, and because a duplicate
// id makes every commit message citing that number ambiguous forever.
const ledger = contents.get("docs/p5-ledger.md");
if (ledger !== undefined) {
  const seen = new Map();
  for (const m of ledger.matchAll(/^\| (D-\d+) \|/gm)) {
    const id = m[1];
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) failures.push(`docs/p5-ledger.md: ${id} appears ${n} times — one id, one defect`);
  }
}

if (failures.length > 0) {
  console.error("GOVERNANCE CHECK FAILED\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nThese files are the project's rulebook. Nothing else in the suite reads them," +
      "\nso this check is the only thing between a bad merge and a repo whose commit" +
      "\nmessages cite doctrine that no longer exists. If a change here is intended," +
      "\nupdate docs/governance.manifest.json in the same commit.",
  );
  process.exit(1);
}

console.log(`governance ok — ${manifest.files.length} files, ${manifest.fingerprint.length} named rules present`);
