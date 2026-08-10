import fs from "node:fs";
import path from "node:path";
import { parseForm4Xml } from "./src/ingesters/form4.ts";
import { pctDisposedOf, closingStakeOf } from "./src/pipeline/insiderFacts.ts";

const dir = "/tmp/p6verify/sample";
const files = fs.readdirSync(dir).filter((f) => f.startsWith("4-") && f.endsWith(".xml")).sort();

// crude holding extractor (regex, same shape as the ingester's helpers)
function holdings(xml) {
  const out = [];
  const re = /<nonDerivativeHolding>([\s\S]*?)<\/nonDerivativeHolding>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const sh = /<sharesOwnedFollowingTransaction>\s*<value>\s*([\d.]+)\s*<\/value>/.exec(b);
    const di = /<directOrIndirectOwnership>\s*<value>\s*(\w)\s*<\/value>/.exec(b);
    const na = /<natureOfOwnership>\s*<value>([\s\S]*?)<\/value>/.exec(b);
    const ti = /<securityTitle>\s*<value>([\s\S]*?)<\/value>/.exec(b);
    out.push({
      shares: sh ? Number(sh[1]) : null,
      direct: di ? di[1] === "D" : true,
      nature: na ? na[1].trim() : null,
      title: ti ? ti[1].trim() : null,
    });
  }
  return out;
}

let printed = 0;
const rows = [];
for (const f of files) {
  const xml = fs.readFileSync(path.join(dir, f), "utf8");
  const doc = parseForm4Xml(xml);
  if (!doc) { console.log("PARSE FAIL", f); continue; }
  const res = pctDisposedOf(doc.nonDerivative);
  const h = holdings(xml);
  if (res) printed++;
  if (h.length === 0) continue;
  const hSum = h.reduce((n, x) => n + (x.shares ?? 0), 0);
  // recompute with holdings folded into the stake
  let alt = null;
  if (res) {
    const disposals = doc.nonDerivative.filter((t) => t.acquiredDisposed === "D" && typeof t.shares === "number");
    const disposed = disposals.reduce((n, t) => n + t.shares, 0);
    const acquired = doc.nonDerivative.filter((t) => t.acquiredDisposed === "A" && typeof t.shares === "number").reduce((n, t) => n + t.shares, 0);
    const sold = disposals.filter((t) => t.code.trim().toUpperCase() === "S").reduce((n, t) => n + t.shares, 0);
    const remaining = closingStakeOf(doc.nonDerivative) + hSum;
    const opening = remaining + disposed - acquired;
    alt = Math.round((sold / opening) * 1000) / 10;
  }
  rows.push({
    file: f,
    codes: [...new Set(doc.nonDerivative.map((t) => t.code))].join(","),
    shippedPct: res ? res.pct : null,
    shippedStake: closingStakeOf(doc.nonDerivative),
    holdingLines: h.map((x) => `${x.direct ? "D" : "I"}|${x.nature ?? ""}|${x.shares}|${x.title}`),
    holdingSum: hSum,
    altPct: alt,
  });
}
console.log("total form4 files:", files.length, " printing pct under SHIPPED code:", printed);
console.log(JSON.stringify(rows, null, 1));
