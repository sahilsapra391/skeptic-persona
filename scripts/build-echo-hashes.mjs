#!/usr/bin/env node
// Offline, dev-only: build the salted 8-gram hash set for the corpus-echo
// check and emit batched SQL for `wrangler d1 execute`.
//
// The corpus (33k competitor posts) lives OUTSIDE the repo and never enters
// it; only hashes reach D1. Usage:
//
//   node scripts/build-echo-hashes.mjs "/path/to/corpus/dir" > /tmp/echo.sql
//   npx wrangler d1 execute skeptic-wire --remote --file /tmp/echo.sql
//
// HASHING CONTRACT: this file inlines the exact algorithm from
// src/rag/echo.ts (fnv1a over "<salt> <8 words>"). test/echo.test.ts pins
// known hash values against BOTH implementations' outputs, so a one-sided
// edit fails the suite. Change one, change both.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NGRAM_SALT = "skeptic-echo-v1";
const NGRAM_N = 8;

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function ngramHashes(text) {
  const words = text.toLowerCase().normalize("NFC").match(/[a-z0-9']+/g) ?? [];
  const out = new Set();
  for (let i = 0; i + NGRAM_N <= words.length; i++) {
    out.add(fnv1a(`${NGRAM_SALT} ${words.slice(i, i + NGRAM_N).join(" ")}`));
  }
  return out;
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/build-echo-hashes.mjs <corpus-dir>");
  process.exit(1);
}

const hashes = new Set();
let posts = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const items = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const t of items) {
    const text = t.full_text ?? t.text ?? "";
    if (!text) continue;
    posts++;
    for (const h of ngramHashes(text)) hashes.add(h);
  }
}
console.error(`${posts} posts -> ${hashes.size} distinct salted 8-gram hashes`);

// Batched inserts: D1 statement limits are generous but keep batches modest.
const all = [...hashes];
const BATCH = 500;
for (let i = 0; i < all.length; i += BATCH) {
  const values = all
    .slice(i, i + BATCH)
    .map((h) => `('${h}')`)
    .join(",");
  console.log(`INSERT OR IGNORE INTO echo_ngrams (hash) VALUES ${values};`);
}
