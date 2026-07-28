import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  allowedNumbers,
  cadenceCheck,
  corpusEchoCheck,
  draftNumbers,
  entityCheck,
  hedgeCheck,
  lengthCheck,
  numberCheck,
  structuralCheck,
  templateEchoCheck,
  collisionCheck,
} from "../src/rag/validate";
import { fnv1a, maskSkeleton, ngramHashes, openerHash, skeletonHash, NGRAM_SALT } from "../src/rag/echo";
import { iso } from "../src/lib/time";

const NOW = new Date("2026-07-28T15:00:00Z");

describe("numberCheck — the no-fabrication floor", () => {
  const payload = {
    amountMin: 1000001,
    amountMax: 5000000,
    lagDays: 45,
    tradeDate: "2026-06-03",
    filedAt: "2026-07-18T19:50:00Z",
    sharesSold: 1200000,
  };

  it("passes numbers the payload carries, in any common rendering", () => {
    expect(numberCheck("Disclosed 45 days later", payload)).toEqual([]);
    expect(numberCheck("$1,000,001 - $5,000,000 band", payload)).toEqual([]);
    expect(numberCheck("1.2M shares", payload)).toEqual([]); // scale variant of 1200000
    expect(numberCheck("1,200,000 shares", payload)).toEqual([]);
    expect(numberCheck("trade date June 3", payload)).toEqual([]); // date component
    expect(numberCheck("filed 19:50", payload)).toEqual([]); // verbatim payload substring
  });

  it("kills any number from nowhere", () => {
    expect(numberCheck("Disclosed 46 days later", payload).map((i) => i.rule)).toEqual(["number"]);
    expect(numberCheck("a $2.5M position", payload).map((i) => i.rule)).toEqual(["number"]);
    expect(numberCheck("up 12% on the news", payload).map((i) => i.rule)).toEqual(["number"]);
  });

  it("never lets the model do arithmetic: derived figures must be payload fields", () => {
    // 5000000 - 1000001 is "computable" but NOT in the payload; the pipeline
    // pre-computes derived figures as fields precisely so this fails.
    expect(numberCheck("a $3,999,999 spread", payload).length).toBe(1);
  });

  it("draftNumbers applies adjacent scale words", () => {
    expect(draftNumbers("1.2 million shares")[0]!.value).toBe(1200000);
    expect(draftNumbers("$5M")[0]!.value).toBe(5000000);
  });

  it("allowedNumbers pulls numbers out of payload strings, dates and bands", () => {
    const allowed = allowedNumbers({ band: "$1,000,001 - $5,000,000", when: "2026-06-03" });
    expect(allowed.has("1000001")).toBe(true);
    expect(allowed.has("5000000")).toBe(true);
    expect(allowed.has("2026")).toBe(true);
    expect(allowed.has("3")).toBe(true);
  });
});

describe("entityCheck", () => {
  const payload = { member: "Nancy Pelosi", ticker: "AVGO", company: "Broadcom Inc" };

  it("passes entities the payload names", () => {
    expect(entityCheck("Nancy Pelosi reported a purchase of $AVGO", payload)).toEqual([]);
  });

  it("kills tickers, names and ALL-CAPS tokens from nowhere", () => {
    expect(entityCheck("a purchase of $NVDA", payload).map((i) => i.rule)).toEqual(["entity"]);
    expect(entityCheck("Josh Gottheimer reported it", payload).map((i) => i.rule)).toEqual(["entity"]);
    expect(entityCheck("the LMT position", payload).map((i) => i.rule)).toEqual(["entity"]);
  });

  it("whitelists wire furniture: attribution vocab, months, form words", () => {
    expect(entityCheck("Filed in June, per SEC, before the FOMC meeting", payload)).toEqual([]);
    expect(entityCheck("per Senate eFD", payload)).toEqual([]);
  });
});

describe("structural law + length", () => {
  it("attribution must ride the fact block", () => {
    expect(structuralCheck("Fact line, per SEC.\n\nThe take.")).toEqual([]);
    expect(structuralCheck("The take first.\n\nFact line, per SEC.").map((i) => i.rule)).toEqual(["structure"]);
  });

  it("at most two segments: fact block + take", () => {
    expect(structuralCheck("A, per SEC.\n\nB.\n\nC.").map((i) => i.rule)).toContain("structure");
  });

  it("commentary has a 200 weighted floor; dry does not", () => {
    const short = "CPI 2.4%, per BLS.";
    expect(lengthCheck(short, "dry")).toEqual([]);
    expect(lengthCheck(short, "commentary").map((i) => i.rule)).toEqual(["length"]);
  });
});

describe("hedge + cadence — constructions, never bare words", () => {
  it("kills the desk hedging its own claim", () => {
    expect(hedgeCheck("This may suggest insiders expected the move").length).toBe(1);
    expect(hedgeCheck("It appears to be a pattern").length).toBe(1);
    expect(hedgeCheck("Make of that what you will.").length).toBe(1);
  });

  it("FALSE-POSITIVE CORPUS: factual record language passes", () => {
    // The three phrases that broke the bare-word advice check on 2026-07-27,
    // plus the 4.02 filing's own hedge — quoted record language is factual.
    for (const factual of [
      "Filed notice to sell 200,000 shares, per SEC Form 144",
      "Leveraged funds net short 45,000 contracts, per CFTC",
      "Treasury auction coming up short of the average bid-to-cover",
      "Prior financials may not be relied upon. That's the filing's own claim.",
    ]) {
      expect(hedgeCheck(factual), factual).toEqual([]);
    }
  });

  it("kills uniform sentence cadence and triple anaphora", () => {
    const uniform = "The filing landed at nine this morning. The market opened lower on the print. The senator disclosed nothing before then.";
    expect(cadenceCheck(uniform).map((i) => i.rule)).toContain("cadence");
    const anaphora = "Nobody filed early. Nobody flagged the trade. Nobody asked why.";
    expect(cadenceCheck(anaphora).map((i) => i.rule)).toContain("cadence");
  });

  it("normal varied prose passes", () => {
    expect(cadenceCheck("Code P. Bought, not granted. The stake number is the filer's own and it grew.")).toEqual([]);
  });
});

describe("echo + collisions", () => {
  it("maskSkeleton collapses content, keeps shape", () => {
    const a = maskSkeleton("Senator Jane Roe bought $LMT, $1,000,001 - $5,000,000, on 06/03.");
    const b = maskSkeleton("Senator John Doe bought $RTX, $250,001 - $500,000, on 05/15.");
    expect(a).toBe(b);
  });

  it("skeleton/opener hashes are stable and the script contract is pinned", () => {
    // Pinned values: if either src/rag/echo.ts or scripts/build-echo-hashes.mjs
    // changes the algorithm one-sidedly, this fails.
    expect(fnv1a(`${NGRAM_SALT} one two three four five six seven eight`)).toBe("8a3156ae");
    expect(skeletonHash("abc")).toBe(fnv1a(maskSkeleton("abc")));
    expect(openerHash("The lag is the product here today")).toBe(openerHash("the lag is the product HERE NOW"));
  });

  it("templateEcho rejects a variant sharing an 8-gram with the template", () => {
    const template = "Senate PTR: purchase reported in the band disclosed forty five days after the trade date, per Senate eFD.";
    const coat = "Senate PTR: purchase reported in the band disclosed forty five days after the trade date. Quite a lag.";
    expect(templateEchoCheck(coat, template).map((i) => i.rule)).toEqual(["template_echo"]);
    expect(templateEchoCheck("A fresh sentence with its own words entirely, per SEC.", template)).toEqual([]);
  });

  it("corpusEcho: empty table is a warned no-op; a seeded hash hits", async () => {
    const text = "one two three four five six seven eight nine";
    const empty = await corpusEchoCheck(env.DB, text);
    expect(empty.issues).toEqual([]);
    expect(empty.corpusEmpty).toBe(true);

    const [h] = [...ngramHashes(text)];
    await env.DB.prepare(`INSERT OR IGNORE INTO echo_ngrams (hash) VALUES (?1)`).bind(h).run();
    const hit = await corpusEchoCheck(env.DB, text);
    expect(hit.issues.map((i) => i.rule)).toEqual(["corpus_echo"]);
    expect(hit.corpusEmpty).toBe(false);
  });

  it("collisionCheck is CROSS-archetype: a HALT shape blocks a PTR draft", async () => {
    // Seed a valid generation from a DIFFERENT archetype's queue row with the
    // same skeleton — the ban post-mortem case: same shape, five archetypes.
    await env.DB.prepare(
      `INSERT INTO items (dedup_key, source, external_id, category, fetched_at, source_url, payload, score, status)
       VALUES ('t:1','edgar_8k','x1','filing',?1,'https://s/1','{}',2,'queued')`,
    ).bind(iso(NOW)).run();
    const item = await env.DB.prepare(`SELECT id FROM items WHERE dedup_key='t:1'`).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO queue (item_id, archetype, draft_text, state, created_at) VALUES (?1,'HALT','d','approved',?2)`,
    ).bind(item!.id, iso(NOW)).run();
    const q = await env.DB.prepare(`SELECT id FROM queue WHERE item_id=?1`).bind(item!.id).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO generations (queue_id, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1,'dry','x','SKEL1','OPEN1','valid',1,?2)`,
    ).bind(q!.id, iso(NOW)).run();

    const issues = await collisionCheck(env.DB, 0, "SKEL1", "fresh");
    expect(issues.map((i) => i.rule)).toEqual(["skeleton_collision"]);
    const openerIssues = await collisionCheck(env.DB, 0, "fresh", "OPEN1");
    expect(openerIssues.map((i) => i.rule)).toEqual(["opener_collision"]);
    expect(await collisionCheck(env.DB, 0, "fresh", "fresh")).toEqual([]);
    // Same-queue variants are alternatives, never collisions:
    expect(await collisionCheck(env.DB, q!.id, "SKEL1", "OPEN1")).toEqual([]);
  });
});
