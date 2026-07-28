import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  cadenceCheck,
  collisionCheck,
  corpusEchoCheck,
  corpusHasData,
  dateCheck,
  draftNumbers,
  entityCheck,
  hedgeCheck,
  lengthCheck,
  motiveCheck,
  numberCheck,
  payloadFacts,
  sourcingCheck,
  structuralCheck,
  templateEchoCheck,
  urlCheck,
  validateVariant,
  wordNumberCheck,
} from "../src/rag/validate";
import { fnv1a, maskSkeleton, ngramHashes, openerHash, skeletonHash, NGRAM_SALT } from "../src/rag/echo";
import { iso } from "../src/lib/time";

const NOW = new Date("2026-07-28T15:00:00Z");

// The canonical PTR payload used by the bypass hunt. Every exploit the
// 45-agent review CONFIRMED against the first version of these validators is
// below as a regression test, quoted from the findings verbatim.
const PTR = {
  amountMin: 1000001,
  amountMax: 5000000,
  lagDays: 45,
  tradeDate: "2026-06-03",
  disclosedDate: "2026-07-18",
  filedAt: "2026-07-18T19:50:00Z",
  sharesSold: 1200000,
  member: "Jane Roe",
  ticker: "LMT",
  company: "Lockheed Martin",
};

describe("numberCheck — the no-fabrication floor", () => {
  it("passes numbers the payload carries, in their common renderings", () => {
    expect(numberCheck("Disclosed 45 days later", PTR)).toEqual([]);
    expect(numberCheck("$1,000,001 - $5,000,000 band", PTR)).toEqual([]);
    expect(numberCheck("1.2M shares", PTR)).toEqual([]); // scale suffix resolves to 1200000
    expect(numberCheck("1,200,000 shares", PTR)).toEqual([]);
    expect(numberCheck("trade date June 3", PTR)).toEqual([]); // structural date match
    expect(numberCheck("filed 19:50", PTR)).toEqual([]); // time verbatim in timestamp
    expect(numberCheck("in 2026", PTR)).toEqual([]); // year rides alone
  });

  it("kills any number from nowhere", () => {
    expect(numberCheck("Disclosed 46 days later", PTR).map((i) => i.rule)).toEqual(["number"]);
    expect(numberCheck("a $2.5M position", PTR).map((i) => i.rule)).toEqual(["number"]);
    expect(numberCheck("a $3,999,999 spread", PTR).length).toBe(1); // arithmetic is fabrication
  });

  it("BYPASS #1 (critical): tiny payload numbers never license scaled-up claims", () => {
    // lagDays 45 licensed "45,000 shares", "$45 billion"; amountMax licensed
    // "$5 billion"; date components licensed "$3 million" / "$7 billion".
    for (const exploit of [
      "Senate PTR: Jane Roe, 45,000 shares of $LMT, per Senate eFD.",
      "a $45 billion position",
      "$5 billion sale",
      "$3 million",
      "$7 billion",
    ]) {
      expect(numberCheck(exploit, PTR).length, exploit).toBeGreaterThan(0);
    }
  });

  it("BYPASS #2 (critical): digit substrings of payload numbers never pass", () => {
    // "100000" rode as a prefix of 1000001; "500000" inside 5000000; etc.
    for (const exploit of ["$100,000 purchase", "$500,000", "$200,000", "$1,000 position", "12 separate purchases"]) {
      expect(numberCheck(exploit, PTR).length, exploit).toBeGreaterThan(0);
    }
    // But the intended verbatim cases still ride: non-digit-bearing tokens.
    expect(numberCheck("filed 19:50", PTR)).toEqual([]);
  });

  it("BYPASS #3 (high): spelled-out numbers are numeric claims", () => {
    expect(wordNumberCheck("nine million shares", payloadFacts(PTR)).length).toBe(1);
    expect(wordNumberCheck("forty-six days", payloadFacts(PTR)).length).toBe(1);
    expect(numberCheck("doubled the stake", PTR).map((i) => i.rule)).toContain("number"); // relative = arithmetic
    expect(numberCheck("half of the position", PTR).map((i) => i.rule)).toContain("number");
    // Everyday small-unit English is NOT a numeric claim...
    expect(wordNumberCheck("no one filed anything", payloadFacts(PTR))).toEqual([]);
    // ...until it quantifies something.
    expect(wordNumberCheck("two filings this week", payloadFacts(PTR)).length).toBe(1); // 2 not in payload
    expect(wordNumberCheck("forty-five days", payloadFacts(PTR))).toEqual([]); // 45 IS in payload
  });

  it("BYPASS #4 (high): recombined dates are rejected; real dates pass", () => {
    expect(numberCheck("trade date June 3", PTR)).toEqual([]);
    expect(numberCheck("public July 18", PTR)).toEqual([]);
    expect(numberCheck("on 2026-06-03", PTR)).toEqual([]);
    // Month from one payload date + day from another = a date that exists
    // nowhere in the record.
    expect(numberCheck("on July 3", PTR).map((i) => i.rule)).toEqual(["number"]);
    expect(numberCheck("on June 18", PTR).map((i) => i.rule)).toEqual(["number"]);
    expect(numberCheck("on 6/18", PTR).map((i) => i.rule)).toEqual(["number"]);
  });

  it("BYPASS #5 (high): payload magnitudes cannot be re-issued as percentages", () => {
    // lagDays 45 must never become "45%"; amount digits must not become bps.
    expect(numberCheck("a 45% stake", PTR).map((i) => i.rule)).toEqual(["number"]);
    expect(numberCheck("up 12%", PTR).map((i) => i.rule)).toEqual(["number"]);
    // A genuine percent-keyed field DOES license its value as a percent.
    const cpi = { headlineYoY: 2.4, coreYoY: 2.8, releaseDate: "2026-07-15" };
    expect(numberCheck("CPI 2.4% y/y. Core 2.8%", cpi)).toEqual([]);
    // ...but not a different number as a percent.
    expect(numberCheck("CPI 3.4% y/y", cpi).map((i) => i.rule)).toEqual(["number"]);
  });

  it("draftNumbers applies adjacent scale words and tags units", () => {
    expect(draftNumbers("1.2 million shares")[0]!.value).toBe(1200000);
    expect(draftNumbers("$5M")[0]!.value).toBe(5000000);
    expect(draftNumbers("45 bps")[0]!.unit).toBe("percent");
  });

  it("payloadFacts: structural dates, guarded scale-down, percent keys", () => {
    const f = payloadFacts(PTR);
    expect(f.dates.has("6-3")).toBe(true);
    expect(f.dates.has("2026-6-3")).toBe(true);
    expect(f.numbers.has("1000001")).toBe(true);
    expect(f.numbers.has("1.2")).toBe(true); // scale-DOWN of 1200000
    expect(f.numbers.has("45000")).toBe(false); // NO scale-up, ever
    expect(f.percents.has("45")).toBe(false); // lagDays is not a percent key
  });
});

describe("entityCheck", () => {
  it("passes entities the payload names", () => {
    expect(entityCheck("Jane Roe reported a purchase of $LMT", PTR)).toEqual([]);
  });

  it("kills tickers, names and ALL-CAPS tokens from nowhere", () => {
    expect(entityCheck("a purchase of $NVDA", PTR).map((i) => i.rule)).toEqual(["entity"]);
    expect(entityCheck("Josh Gottheimer reported it", PTR).map((i) => i.rule)).toEqual(["entity"]);
    expect(entityCheck("the RTX position", PTR).map((i) => i.rule)).toEqual(["entity"]);
  });

  it("BYPASS #16: case and boundaries — payload 'Jane Roe' never licenses $ROE", () => {
    expect(entityCheck("watch $ROE here", PTR).map((i) => i.rule)).toEqual(["entity"]);
    expect(entityCheck("the LOCK trade", PTR).map((i) => i.rule)).toEqual(["entity"]); // 'Lockheed' is not 'LOCK'
    expect(entityCheck("$LMT", PTR)).toEqual([]); // real ticker, case-exact
  });

  it("BYPASS #6: fabricated institutions are not exempted by a furniture PREFIX", () => {
    expect(entityCheck("referred to the Senate Ethics Committee", PTR).map((i) => i.rule)).toEqual(["entity"]);
    expect(entityCheck("per Senate eFD", PTR)).toEqual([]); // exact furniture still free
  });

  it("BYPASS #19: hyphenated surnames are checked as compound names", () => {
    expect(entityCheck("Ocasio-Cortez filed late", PTR).map((i) => i.rule)).toEqual(["entity"]);
    const aoc = { member: "Alexandria Ocasio-Cortez" };
    expect(entityCheck("Ocasio-Cortez filed late", aoc)).toEqual([]);
  });

  it("whitelists wire furniture: attribution vocab, months, form words", () => {
    expect(entityCheck("Filed in June, per SEC, before the FOMC meeting", PTR)).toEqual([]);
  });
});

describe("sourcing + url — non-negotiable #2, mechanically", () => {
  it("kills secondary sourcing constructions", () => {
    for (const bad of [
      "reportedly sold before the vote",
      "sources say the filing is coming",
      "according to reports, more filings follow",
      "per Bloomberg, the stake grew",
    ]) {
      expect(sourcingCheck(bad).map((i) => i.rule), bad).toContain("sourcing");
    }
  });

  it("our own attributions and rate-phrases pass", () => {
    for (const ok of ["per Senate eFD.", "per SEC Form 4.", "250 posts per day", "$4 per share"]) {
      expect(sourcingCheck(ok), ok).toEqual([]);
    }
  });

  it("BYPASS #10: URLs in the post body are rejected regardless of prompt obedience", () => {
    expect(urlCheck("see https://efdsearch.senate.gov/x").map((i) => i.rule)).toEqual(["url"]);
    expect(urlCheck("at www.sec.gov")).toHaveLength(1);
    expect(urlCheck("plain text, per SEC")).toEqual([]);
  });
});

describe("motive — the defamation surface, directly (finding #15)", () => {
  it("kills every imputation construction in the bank", () => {
    for (const bad of [
      "The senator knew exactly what was coming",
      "they knew",
      "known all along",
      "she was aware of the announcement",
      "had reason to expect the contract",
      "the timing speaks for itself",
      "conveniently filed after the close",
      "quietly sold the position",
      "a coordinated exit",
      "that is not a coincidence",
      "front-running the announcement",
    ]) {
      expect(motiveCheck(bad).map((i) => i.rule), bad).toEqual(["motive"]);
    }
  });

  it("FALSE-POSITIVE CORPUS: stating the record is not imputation", () => {
    for (const ok of [
      "The trade is legal, the lag is legal, and the lag is the whole story.",
      "Disclosed 45 days later.",
      "The filing made the dates public.",
      "The cluster is the fact. The reason isn't filed.",
    ]) {
      expect(motiveCheck(ok), ok).toEqual([]);
    }
  });
});

describe("hedge + cadence — constructions, never bare words", () => {
  it("kills the desk hedging its own claim, including the review's dodges", () => {
    for (const bad of [
      "This may suggest insiders expected the move",
      "It appears to be a pattern",
      "Make of that what you will.",
    ]) {
      expect(hedgeCheck(bad).length, bad).toBe(1);
    }
  });

  it("FALSE-POSITIVE CORPUS: factual record language passes", () => {
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
    const uniform =
      "The filing landed at nine this morning. The market opened lower on the print. The senator disclosed nothing before then.";
    expect(cadenceCheck(uniform).map((i) => i.rule)).toContain("cadence");
    const anaphora = "Nobody filed early. Nobody flagged the trade. Nobody asked why.";
    expect(cadenceCheck(anaphora).map((i) => i.rule)).toContain("cadence");
  });

  it("normal varied prose passes", () => {
    expect(cadenceCheck("Code P. Bought, not granted. The stake number is the filer's own and it grew.")).toEqual([]);
  });
});

describe("structure + length", () => {
  it("attribution must ride the fact block; two segments max", () => {
    expect(structuralCheck("Fact line, per SEC.\n\nThe take.")).toEqual([]);
    expect(structuralCheck("The take first.\n\nFact line, per SEC.").map((i) => i.rule)).toEqual(["structure"]);
    expect(structuralCheck("A, per SEC.\n\nB.\n\nC.").map((i) => i.rule)).toContain("structure");
  });

  it("commentary has a 200 weighted floor; dry does not", () => {
    const short = "CPI 2.4%, per BLS.";
    expect(lengthCheck(short, "dry")).toEqual([]);
    expect(lengthCheck(short, "commentary").map((i) => i.rule)).toEqual(["length"]);
  });
});

describe("echo + collisions", () => {
  it("maskSkeleton collapses content, keeps shape", () => {
    const a = maskSkeleton("Senator Jane Roe bought $LMT, $1,000,001 - $5,000,000, on 06/03.");
    const b = maskSkeleton("Senator John Doe bought $RTX, $250,001 - $500,000, on 05/15.");
    expect(a).toBe(b);
  });

  it("HASHING CONTRACT: ngramHashes output is pinned, not just fnv1a (finding #11)", () => {
    // The first version pinned fnv1a alone, and a literal NUL byte hiding in
    // ngramHashes' template string made every runtime hash diverge from the
    // offline script — invisibly, because the pin never went THROUGH
    // ngramHashes. This does.
    expect(fnv1a(`${NGRAM_SALT} one two three four five six seven eight`)).toBe("8a3156ae");
    expect(ngramHashes("one two three four five six seven eight").has("8a3156ae")).toBe(true);
    expect(skeletonHash("abc")).toBe(fnv1a(maskSkeleton("abc")));
    expect(openerHash("The lag is the product here today")).toBe(openerHash("the lag is the product HERE NOW"));
  });

  it("templateEcho rejects a variant sharing an 8-gram with the template", () => {
    const template = "Senate PTR: purchase reported in the band disclosed forty five days after the trade date, per Senate eFD.";
    const coat = "Senate PTR: purchase reported in the band disclosed forty five days after the trade date. Quite a lag.";
    expect(templateEchoCheck(coat, template).map((i) => i.rule)).toEqual(["template_echo"]);
    expect(templateEchoCheck("A fresh sentence with its own words entirely, per SEC.", template)).toEqual([]);
  });

  it("corpusHasData + corpusEchoCheck: empty is empty; a seeded hash hits", async () => {
    const text = "one two three four five six seven eight nine";
    expect(await corpusHasData(env.DB)).toBe(false);
    const [h] = [...ngramHashes(text)];
    await env.DB.prepare(`INSERT OR IGNORE INTO echo_ngrams (hash) VALUES (?1)`).bind(h).run();
    expect(await corpusHasData(env.DB)).toBe(true);
    expect((await corpusEchoCheck(env.DB, text)).map((i) => i.rule)).toEqual(["corpus_echo"]);
    expect(await corpusEchoCheck(env.DB, "totally different words that never overlap anything at all today")).toEqual([]);
  });

  it("collisionCheck is CROSS-archetype and excludes the same queue row", async () => {
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

    expect((await collisionCheck(env.DB, 0, "SKEL1", "fresh")).map((i) => i.rule)).toEqual(["skeleton_collision"]);
    expect((await collisionCheck(env.DB, 0, "fresh", "OPEN1")).map((i) => i.rule)).toEqual(["opener_collision"]);
    expect(await collisionCheck(env.DB, 0, "fresh", "fresh")).toEqual([]);
    // Same-queue variants are alternatives, never collisions:
    expect(await collisionCheck(env.DB, q!.id, "SKEL1", "OPEN1")).toEqual([]);
  });
});

describe("validateVariant assembly (finding #13: the wiring itself)", () => {
  const opts = (over: Partial<Parameters<typeof validateVariant>[2]> = {}) => ({
    queueId: 0,
    variant: "commentary" as const,
    archetype: "CONGRESS_PTR" as const,
    payload: PTR,
    templateDraft: "Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase, trade date 2026-06-03, per Senate eFD",
    skeletonHash: "fresh-skel",
    openerHash: "fresh-open",
    corpusPopulated: false,
    ...over,
  });

  const CLEAN_COMMENTARY =
    "Senate PTR: Jane Roe bought $1,000,001 - $5,000,000 of $LMT, trade date June 3, public July 18, per Senate eFD.\n\nThe disclosure took 45 days. The trade is lawful, the lag is lawful, and the lag is also the only story this filing has to tell.";

  it("a clean commentary passes the full gate", async () => {
    expect(await validateVariant(env.DB, CLEAN_COMMENTARY, opts())).toEqual([]);
  });

  it("GROUP ORDER IS CONTRACT (finding #36): doctrine failure outranks style failure", async () => {
    // Fabricated number AND a hedge: the FIRST issue must be the number.
    const both =
      "Senate PTR: Jane Roe bought $9,999,999 of $LMT, trade date June 3, public July 18, per Senate eFD.\n\nIt appears to be a pattern, and the disclosure took 45 days either way, which the record shows plainly.";
    const issues = await validateVariant(env.DB, both, opts());
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues[0]!.rule).toBe("number");
  });

  it("drives corpus echo through the assembly when populated", async () => {
    for (const h of ngramHashes(CLEAN_COMMENTARY)) {
      await env.DB.prepare(`INSERT OR IGNORE INTO echo_ngrams (hash) VALUES (?1)`).bind(h).run();
    }
    const issues = await validateVariant(env.DB, CLEAN_COMMENTARY, opts({ corpusPopulated: true }));
    expect(issues.map((i) => i.rule)).toContain("corpus_echo");
    // And skips the query when told the corpus is empty:
    expect(await validateVariant(env.DB, CLEAN_COMMENTARY, opts({ corpusPopulated: false }))).toEqual([]);
  });

  it("drives template echo through the assembly for commentary only", async () => {
    const coat = `${"Senate PTR: Jane Roe, $1,000,001 - $5,000,000 purchase, trade date"} June 3, per Senate eFD.\n\nThe record is complete on that point and the reader can weigh the lag of 45 days without any help from this desk.`;
    const issues = await validateVariant(env.DB, coat, opts());
    expect(issues.map((i) => i.rule)).toContain("template_echo");
  });

  it("drives collisions through the assembly", async () => {
    await env.DB.prepare(
      `INSERT INTO items (dedup_key, source, external_id, category, fetched_at, source_url, payload, score, status)
       VALUES ('t:2','edgar_8k','x2','filing',?1,'https://s/2','{}',2,'queued')`,
    ).bind(iso(NOW)).run();
    const item = await env.DB.prepare(`SELECT id FROM items WHERE dedup_key='t:2'`).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO queue (item_id, archetype, draft_text, state, created_at) VALUES (?1,'HALT','d','approved',?2)`,
    ).bind(item!.id, iso(NOW)).run();
    const q = await env.DB.prepare(`SELECT id FROM queue WHERE item_id=?1`).bind(item!.id).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO generations (queue_id, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
       VALUES (?1,'dry','x',?2,'other','valid',1,?3)`,
    ).bind(q!.id, skeletonHash(CLEAN_COMMENTARY), iso(NOW)).run();
    const issues = await validateVariant(env.DB, CLEAN_COMMENTARY, opts({ skeletonHash: skeletonHash(CLEAN_COMMENTARY) }));
    expect(issues.map((i) => i.rule)).toContain("skeleton_collision");
  });
});

describe("dateCheck consumes what it validates", () => {
  it("consumed dates leave no digits for the numeric pass", () => {
    const facts = payloadFacts(PTR);
    const { issues, remainder } = dateCheck("trade date June 3, public 2026-07-18", facts);
    expect(issues).toEqual([]);
    expect(remainder).not.toMatch(/June|07-18/);
  });
});
