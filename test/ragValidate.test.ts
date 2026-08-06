import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  beatShapeCheck,
  cadenceCheck,
  ALL_ANCHOR_FIELDS,
  NON_ANCHOR_FIELDS,
  checkGroundingProvenance,
  looksLikeProse,
  groundingFacts,
  mergeFacts,
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
import { ARCHETYPES } from "../src/templates/archetypes";
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

describe("grounding provenance — wrong document is a fabrication license", () => {
  const filing = { company: "Blink Charging Co", ticker: "BLNK", issuerCik: "1429764", itemCode: "3.01" };

  it("ANCHOR COVERAGE AUDIT: every live payload shape offers an anchor (the test the comment promised)", () => {
    // validate.ts exported ALL_ANCHOR_FIELDS "for the audit test" and the
    // audit was never written — a promise in a comment, which is its own
    // instance of the pattern this work is about. Here it is. Shapes taken
    // from the live ingesters; a source absent from an anchor field is a
    // source the gate silently fail-opens for.
    const LIVE_PAYLOAD_SHAPES: Record<string, string[]> = {
      FILING_8K: ["company", "cik", "itemCodes"],
      FILING_FORM4: ["issuer", "issuerCik", "ticker", "insiderName"],
      CONGRESS_PTR: ["member", "chamber", "ticker"],
      SENATE_PTR_RAW: ["display", "who", "lastName"],
      PRODUCT_RECALL: ["firm", "product", "classification"],
      REGULATORY_NEWS: ["authority", "title", "publishedIso"],
      FED_PRESS: ["title", "publishedIso"],
      HALT: ["symbol", "reasonCode", "haltTimeEtShort"],
      OWNERSHIP_STAKE: ["issuer", "cik", "pct"],
      MACRO_PRINT: ["headlineYoY", "coreYoY", "releaseDate"],
      RATE_DECISION: ["country", "rate", "effectiveDate"],
    };
    const uncovered: string[] = [];
    for (const [archetype, fields] of Object.entries(LIVE_PAYLOAD_SHAPES)) {
      if (!fields.some((f) => ALL_ANCHOR_FIELDS.includes(f))) uncovered.push(archetype);
    }
    // MACRO_PRINT and RATE_DECISION legitimately have no entity — a CPI print
    // is about no company — so they fail-open by nature and are exempted
    // EXPLICITLY rather than by omission.
    expect(uncovered.sort()).toEqual(["MACRO_PRINT", "RATE_DECISION"]);
    // And the site-wide fields must never be counted as anchors.
    for (const f of NON_ANCHOR_FIELDS) expect(ALL_ANCHOR_FIELDS).not.toContain(f);
  });

  it("REGRESSION: TEN REAL FILERS whose name reduces to a common word license nothing", () => {
    // Owner set a hard bar on this gate: it is the one validator whose failure
    // puts invented facts on the account. So the poison cases are REAL, pulled
    // from our own issuers table (8,043 rows) — not invented. 2,081 of those
    // (26%) have a conformed name that reduces to a single token; these ten
    // reduce to a common English word.
    const REAL_FILERS = [
      "Block, Inc.", "BOX INC", "CROWN HOLDINGS, INC.", "Freedom Holding Corp.",
      "Frontier Group Holdings, Inc.", "GAP INC", "Noble Corp plc", "On Holding AG",
      "Target Group Inc.", "TARGET CORP",
    ];
    const unrelated =
      "Acme Industries said the block trade will close now that the gap in coverage is on target. " +
      "The box was noted, a crown jewel asset, giving freedom at the frontier with noble intent.";
    for (const company of REAL_FILERS) {
      expect(checkGroundingProvenance(unrelated, { company }).ok, company).toBe(false);
    }
  });

  it("...and each still matches its OWN document", () => {
    for (const company of ["Block, Inc.", "BOX INC", "CROWN HOLDINGS, INC.", "GAP INC", "On Holding AG"]) {
      const own = `${company} today announced results for the quarter ended June 30, 2026, and filed a current report.`;
      expect(checkGroundingProvenance(own, { company }).ok, company).toBe(true);
    }
  });

  it("a name that cannot discriminate is DROPPED, never guessed", () => {
    // "RH" reduces to one token in both forms, so no form of it can prove
    // provenance. Dropping falls through to a VISIBLE fail-open rather than
    // matching "rh" anywhere it appears.
    const v = checkGroundingProvenance("Some unrelated prose mentioning rh in passing, at length, with many other words here.", { company: "RH" });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("no_usable_anchor"); // visible, not silent
    expect(v.matched).toBeNull();
  });

  it("dotted and EDGAR-state name forms still match (punctuation runs before suffix stripping)", () => {
    const cases: Array<[string, string]> = [
      ["ENTERPRISE PRODUCTS PARTNERS L.P.", "Enterprise Products Partners LP reported quarterly distributable cash flow today."],
      ["Nestle S.A.", "Nestle SA announced the divestiture of its water brands portfolio today."],
      ["BANK OF AMERICA CORP /DE/", "Bank of America Corporation filed a current report with the Commission today."],
    ];
    for (const [company, body] of cases) {
      expect(checkGroundingProvenance(body, { company }).ok, company).toBe(true);
    }
  });

  // A ticker is a word, and the first two attempts to handle that used a length
  // floor — ">= 4 chars or a digit". Measured against the live issuers table:
  // of 5,906 four- and five-character tickers, 371 are ordinary English words.
  // Measured against 14 real 8-K filings from the EDGAR daily index for
  // 2026-07-30/31, EVERY filing contains at least 11 of them as bare prose
  // (median 23). The floor did not leak sometimes; it licensed everything.
  const WORD_TICKERS = [
    "LOVE", "WELL", "FORM", "LINE", "SUCH", "WHEN", "ELSE", "MAIN",
    "REAL", "SAFE", "CASH", "COST", "PLAY", "ROAD", "PATH", "LIFE", "WAVE",
  ] as const;

  it("HIGH: a word-shaped ticker in bare prose licenses NOTHING, at any length", () => {
    // One sentence of ordinary filing boilerplate containing every one of them.
    const prose =
      "When the board reviewed the real cost of the main line of business, it " +
      "found no safe path forward, and so the form of the transaction was " +
      "changed. Cash on hand will fund the road ahead; nothing else in the " +
      "life of the agreement rides on such a wave, and there is much to love " +
      "about how well the plan reads.";
    const licensed = WORD_TICKERS.filter((t) => checkGroundingProvenance(prose, { ticker: t }).ok);
    expect(licensed).toEqual([]);
  });

  it("a symbol anchors only where a filing PRINTS it as a symbol", () => {
    // The four shapes real filings and releases actually use.
    for (const body of [
      "Lovesac Company (NASDAQ: LOVE) today reported results for the quarter.",
      "The Lovesac Company (LOVE) filed a current report with the Commission.",
      'The shares trade under the symbol "LOVE" on the Nasdaq Global Market.',
      "Title of each class\nCommon Stock\nTrading Symbol(s)\nLOVE\nName of each exchange",
    ]) {
      expect(checkGroundingProvenance(body, { ticker: "LOVE" }).matched, body.slice(0, 40)).toBe("LOVE");
    }
  });

  it("case is load-bearing — a lowercase word is never the uppercase symbol", () => {
    // "well" in prose vs WELL, a live ticker. Same letters, opposite verdicts.
    expect(checkGroundingProvenance("The transaction was received well by the market, as noted.", { ticker: "WELL" }).ok)
      .toBe(false);
    expect(checkGroundingProvenance("Welltower Inc. (NYSE: WELL) filed a current report today.", { ticker: "WELL" }).matched)
      .toBe("WELL");
  });

  it("a present-but-unprinted symbol fails CLOSED, not open", () => {
    // Absence of the symbol is not absence of evidence: we had something to
    // test with and it did not check out, so licensing is withheld.
    const v = checkGroundingProvenance("Acme Industries announced a restructuring of its operations today.", { ticker: "LOVE" });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("no_anchor");
  });

  it("three-letter word tickers are not conclusive identifiers", () => {
    // ALL (Allstate) and NOW (ServiceNow) are live ticker values, and under
    // identifiers-first ordering a word match would be FIRST and final.
    expect(checkGroundingProvenance("The company said all outstanding shares would be exchanged.", { ticker: "ALL" }).ok)
      .toBe(false);
    expect(checkGroundingProvenance("Blink Charging Co (NASDAQ: BLNK) common stock will be suspended.", { ticker: "BLNK" }).matched)
      .toBe("BLNK");
  });

  it("HIGH: another company's document is REJECTED — no single shared token licenses it", () => {
    // Review finding: the longest-token fallback matched "pharmaceuticals",
    // so a Sorrento filing licensed itself against an Acme payload. Any two
    // issuers sharing Holdings/Technologies/Capital/Partners had the same hole.
    const sorrento = "Sorrento Pharmaceuticals, Inc. today announced that its board approved a restructuring. Sorrento Pharmaceuticals will file the related agreements as exhibits to a current report.";
    const v = checkGroundingProvenance(sorrento, { company: "Acme Pharmaceuticals, Inc.", cik: "0001234567" });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("no_anchor");
  });

  it("IDENTIFIERS are consulted BEFORE names, so a weak path cannot decide first", () => {
    // Previously `company` sat at index 0 and `cik` at index 6, so the token
    // fallback settled it before the conclusive anchor was ever tried.
    const doc = "Central Index Key 1429764 filed this report today with the Commission.";
    expect(checkGroundingProvenance(doc, { cik: "1429764", company: "Blink Charging Co" }).matched).toBe("1429764");
  });

  it("names match WHOLE after normalisation — legal suffixes and punctuation do not break it", () => {
    const filing = "On July 28, 2026, BLINK CHARGING CO. received a letter from the Listing Qualifications Department.";
    expect(checkGroundingProvenance(filing, { company: "Blink Charging Co" }).matched).toBe("Blink Charging Co");
  });

  it("MEDIUM: recall payloads have anchors now, and the FDA landing page is rejected", () => {
    // PRODUCT_RECALL carries {firm, product} — absent from the old field list,
    // so anchorsTried was 0 and the gate fail-opened on precisely the source
    // whose source_url is always a landing page.
    const landing = "Recalls, Market Withdrawals, & Safety Alerts. FDA posts press releases and other notices of recalls and market withdrawals from the firms involved as a service to consumers.";
    const v = checkGroundingProvenance(landing, { firm: "Acme Labs LLC", product: "Lot 44 tablets" });
    expect(v.anchorsTried).toBe(2);
    expect(v.ok).toBe(false);
  });

  it("LOW: 'authority' alone never licenses — it matches every page on the regulator's site", () => {
    const footer = "This page is part of an archive maintained for reference. Content on SEC.gov is provided for informational purposes and does not constitute legal advice to any person or entity.";
    const v = checkGroundingProvenance(footer, { authority: "SEC" });
    // No usable anchor at all, so it fail-opens — but VISIBLY, with a reason
    // the caller logs, rather than silently claiming verification.
    expect(v.reason).toBe("no_usable_anchor");
    expect(v.anchorsTried).toBe(0);
  });

  it("REJECTS the EDGAR index chrome that started this (no payload anchor in it)", () => {
    // Shape of the real 2,077-char mis-fetch: navigation + a GTM snippet,
    // non-empty and healthy-looking, mentioning neither company nor ticker.
    const chrome = `EDGAR Filing Documents Home Search Company Filings About Contact
      (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start': new Date().getTime(),event:'gtm.js'});
      var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id=GTM-1234567';})
      SEC.gov Accessibility Privacy Budget and Performance Inspector General No FEAR Act`;
    const v = checkGroundingProvenance(chrome, filing);
    expect(v.ok).toBe(false);
    expect(v.anchorsTried).toBeGreaterThan(0);
  });

  it("ACCEPTS the real filing body on any one anchor", () => {
    expect(checkGroundingProvenance("Blink Charging Co. received a notice from Nasdaq...", filing).ok).toBe(true);
    expect(checkGroundingProvenance("Blink Charging Co (Nasdaq: BLNK) common stock will be suspended.", filing).ok).toBe(true);
    expect(checkGroundingProvenance("Central Index Key 1429764 filed this report.", filing).ok).toBe(true);
    // Trailing-period mismatch must not reject: longest-token fallback.
    expect(checkGroundingProvenance("BLINK CHARGING CO. ANNOUNCES...", filing).matched).toBe("Blink Charging Co");
  });

  it("a BARE ticker no longer licenses, even a non-word one like BLNK", () => {
    // The cost of the shape rule, stated rather than hidden. It is a false
    // negative only for a document that prints the symbol bare AND never names
    // the company or its CIK — which no real filing does. Measured: all 14
    // 8-Ks sampled from the EDGAR daily index print their own cover-page
    // symbol in symbol shape, 14 of 14, so recall on real bodies is unharmed.
    expect(checkGroundingProvenance("...the common stock of BLNK will be suspended...", { ticker: "BLNK" }).ok)
      .toBe(false);
    // And the same body is still accepted via the name or the CIK.
    expect(checkGroundingProvenance("...the common stock of BLNK will be suspended...", filing).reason)
      .toBe("no_anchor");
  });

  it("token-bounded: a substring of a longer word is NOT a match", () => {
    expect(checkGroundingProvenance("The BLNKX fund reported inflows.", { ticker: "BLNK" }).ok).toBe(false);
  });

  it("REJECTS a PDF whose METADATA carries the company name — the anchor check alone is not enough", () => {
    // Verified, not assumed: SEC litigation PDFs carry
    // /Title (In the Matter of <RESPONDENT>), so a tag-stripped PDF contains
    // the payload's company AND 106k chars of object tables. The anchor test
    // passes on this; only the prose test refuses it.
    const pdfish = `%PDF-1.6 /Type /Catalog /Pages 2 0 R
      /Title (In the Matter of ACME CAPITAL ADVISERS LLC) /Producer (Acrobat)
      1 0 obj << /Length 93 /Filter /FlateDecode >> stream
      xref 0 312 /Size 312 /Prev 223302 /Root 1 0 R
      0000000000 65535 f 0000000015 00000 n 0000223302 00000 n
      /Length 41728 /Type /Font /BaseFont /Times-Roman trailer << /Size 312 >> startxref 224891 %%EOF`;
    const acme = { company: "ACME CAPITAL ADVISERS LLC", authority: "SEC" };
    // The anchor IS present — proving the two checks are not redundant.
    expect(pdfish.toLowerCase()).toContain("acme capital advisers llc");
    const v = checkGroundingProvenance(pdfish, acme);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("not_prose");
    // And the consequence it prevents:
    expect(groundingFacts(pdfish).numbers.has("223302")).toBe(true);
  });

  it("REJECTS a tag-stripped spreadsheet — binary is binary at ANY length", () => {
    // The hole my own 20-token exemption opened, found by testing against the
    // XLSX class rather than assuming the prose ratio covered it. A stripped
    // .xlsx is ~10 tokens (binary has no spaces), so it was EXEMPT, and its
    // docProps title carries the payload's authority.
    const strippedXlsx = "PK\u0003\u0004\u0014\u0000\u0000\u0000\b\u0000\uFFFD\uFFFD\u0001]\uFFFDtk [Content_Types].xml \uFFFDM \uFFFD Bank of Japan Monetary Base 223302 41728";
    expect(strippedXlsx.split(/\s+/).filter(Boolean).length).toBeLessThan(20); // under the exemption
    expect(looksLikeProse(strippedXlsx)).toBe(false);
    const v = checkGroundingProvenance(strippedXlsx, { authority: "Bank of Japan" });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("not_prose");
  });

  it("short LEGITIMATE text stays exempt — the reason the floor exists", () => {
    // Lake-context lines are terse by design and must not be rejected.
    for (const terse of [
      "Second non-reliance filing from this issuer this year.",
      "3 prior halts on this symbol today.",
      "Filed 2026-06-03, disclosed 2026-07-18.",
    ]) {
      expect(looksLikeProse(terse), terse).toBe(true);
    }
  });

  it("looksLikeProse separates document internals from every real sample", () => {
    expect(looksLikeProse("%PDF-1.6 /Type /Catalog /Length 93 /Prev 223302 xref 0 312 f n /BaseFont /Times-Roman trailer /Size 312 startxref 224891 %%EOF /Filter /FlateDecode stream endstream obj endobj")).toBe(false);
    for (const real of [
      "On July 28, 2026, Blink Charging Co. received a letter from the Listing Qualifications Department of The Nasdaq Stock Market LLC notifying the Company that the closing bid price was below the minimum requirement for continued listing.",
      "The Federal Trade Commission today sued to block the proposed acquisition, alleging that the deal would eliminate head-to-head competition between two of the largest suppliers and would likely lead to higher prices.",
      "Senate PTR: $1,000,001 - $5,000,000 purchase in a defense prime, trade date June 3, per Senate eFD. Filed July 18. Legal, disclosed, and six weeks stale. Working as intended, apparently.",
    ]) {
      expect(looksLikeProse(real), real.slice(0, 40)).toBe(true);
    }
    // Short text is exempt: a ratio over a few tokens is noise.
    expect(looksLikeProse("/Size 312 /Prev 223302")).toBe(true);
  });

  it("KNOWN RESIDUAL: an index page for the SAME record passes both gates (live SEC text)", () => {
    // Verified against the live URL the p4 session flagged in review:
    // https://www.sec.gov/Archives/edgar/data/1777393/000177739326000057/0001777393-26-000057-index.htm
    //
    // My earlier tests only proved the gates reject SYNTHETIC wrong-document
    // text. Against real production content they both PASS, and 43 numbers
    // stay licensed. Pinned as a failing-by-design fact so the gap is visible
    // in the suite rather than only in a review thread.
    //
    // WHY NO CONTENT TEST CAN CLOSE IT: this is not the wrong document, it is
    // the RIGHT RECORD's wrong representation. The index page is legitimately
    // about accession 0001777393-26-000057, so every identifier the payload
    // carries is honestly present. Note which anchor matches below — the CIK,
    // because the accession number CONTAINS the CIK. That also rules out
    // "require a payload-specific discriminator like the accession number":
    // the index page is TITLED with the accession number.
    //
    // The durable fix is upstream (#75's shape): pre-populate raw_text from
    // the primary document so the source_url fallback never fires. When that
    // covers a source, this text stops being reachable for it.
    const liveIndexText = `EDGAR Filing Documents for 0001777393-26-000057 This page uses Javascript. Your browser either doesn't support Javascript or you have it turned off. To see this page as it is meant to appear please use a Javascript enabled browser. SEC.gov EDGAR Latest Filings Filings search tools Filing Detail SEC Home &#187; Company Search &#187; Current Page Form 8-K - Current report: SEC Accession No. 0001777393-26-000057 Filing Date 2026-07-31 Accepted 2026-07-31 17:28:25 Documents 11 Period of Report 2026-07-28 Items Item 2.05: Cost Associated with Exit or Disposal Activities Item 5.02: Departure of Directors or Certain Officers; Election of D`;
    const payload = { cik: "0001777393", company: "ChargePoint Holdings, Inc." };

    expect(looksLikeProse(liveIndexText)).toBe(true); // navigation chrome IS prose
    const v = checkGroundingProvenance(liveIndexText, payload);
    expect(v.ok).toBe(true);
    expect(v.matched).toBe("0001777393"); // the CIK, matched inside the accession

    // The consequence, stated so it cannot be lost: junk enters the whitelist.
    const licensed = groundingFacts(liveIndexText).numbers;
    expect(licensed.has("57")).toBe(true); // accession fragment
    expect(licensed.has("26")).toBe(true); // accession fragment
  });

  it("ABSENCE is not wrongness — no grounding and no anchors both pass", () => {
    expect(checkGroundingProvenance("", filing).ok).toBe(true);
    expect(checkGroundingProvenance("some text", { publishedIso: "2026-07-31" }).ok).toBe(true);
  });

  it("the whitelist does NOT widen on unverified grounding — the actual threat", () => {
    // A wrong document's numbers must not become legal in our posts.
    const wrong = "Unrelated Corp reported 99,999 units and a $7,777,777 charge.";
    expect(checkGroundingProvenance(wrong, filing).ok).toBe(false);
    // Proof of consequence: if it HAD been merged, 99,999 would validate.
    const widened = mergeFacts(payloadFacts(filing), groundingFacts(wrong));
    expect(widened.numbers.has("99999")).toBe(true);
    // Gated instead, the payload-only whitelist rejects it.
    expect(numberCheck("99,999 units, per SEC", filing).map((i) => i.rule)).toEqual(["number"]);
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

  it("MAP-FORM attributions are legal: every press authority and every central bank", () => {
    // The allowlist derives from ARCHETYPES at module load and normalises the
    // string-or-map form, so PRESS_ATTRIBUTION (payload.authority) and the
    // rate map (payload.country) are covered with no per-source maintenance.
    // Pinned because a regression here silently rejects whole sources.
    const mapped = Object.values(ARCHETYPES).flatMap((a): string[] => {
      const attr: unknown = a.attribution;
      return typeof attr === "string" ? [] : Object.values((attr as { map?: Record<string, string> }).map ?? {});
    });
    expect(mapped.length, "no map-form attributions found — did the shape change?").toBeGreaterThan(3);
    for (const attr of mapped) {
      expect(sourcingCheck(`Something happened, ${attr}.`), attr).toEqual([]);
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

describe("beatShapeCheck — a beat is a sentence (found in the first live generation)", () => {
  it("rejects the lowercase fragment the model actually shipped", () => {
    const real = "CFTC orders George Santos to pay $35,000 for manipulative trading, per CFTC.\n\npay $35,000.";
    expect(beatShapeCheck(real).map((i) => i.rule)).toEqual(["beat_shape"]);
  });

  it("FALSE-POSITIVE CORPUS: the owner's own beats all pass, including his echoes", () => {
    for (const ok of [
      "Senate PTR: sale, filed nine days later, per Senate eFD.\n\nNine days.", // his echo
      "Form 4: director bought 25,000 shares, per SEC.\n\nPosition up 31%.",
      "Four Form 4s, same issuer, per SEC.\n\nFour signatures, not one.",
      "8-K, Item 4.02, per SEC.\n\nTheir words, about their own numbers.",
      "CFTC orders a payment, per CFTC.\n\n$35,000, in the order's own figure.", // non-alpha opener
    ]) {
      expect(beatShapeCheck(ok), ok.slice(-30)).toEqual([]);
    }
  });

  it("catches a SINGLE-newline beat — the original defect, one newline away", () => {
    // Review finding: splitting only on blank lines meant the live
    // `pay $35,000.` case passed when separated by \n instead of \n\n.
    const single = "CFTC orders George Santos to pay $35,000 for manipulative trading, per CFTC.\npay $35,000.";
    expect(beatShapeCheck(single).map((i) => i.rule)).toEqual(["beat_shape"]);
  });

  it("does NOT reject issuers whose names begin lowercase", () => {
    // Deterministic false positives on companies we actually cover.
    for (const beat of ["iShares was not the buyer.", "eBay's second restatement this year.", "loanDepot filed late."]) {
      expect(beatShapeCheck(`Fact block, per SEC.\n\n${beat}`), beat).toEqual([]);
    }
    // A genuine fragment is still caught.
    expect(beatShapeCheck("Fact block, per SEC.\n\npay $35,000.").length).toBe(1);
  });

  it("checks every segment, not just the first take", () => {
    expect(beatShapeCheck("Fact, per SEC.\n\nGood sentence.\n\nand a bad fragment.").length).toBe(1);
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

  it("corpusEchoCheck CHUNKS under D1's 100-parameter cap — long text must not throw", async () => {
    // Reproduced from review: one bound parameter per distinct 8-gram, and D1
    // raises "variable number must be between ?1 and ?100" past that. Text
    // over ~108 word tokens crossed it, and a throw inside validateVariant
    // escapes runGeneration — a crashed run, not a rejected variant.
    const long = Array.from({ length: 400 }, (_, i) => `token${i}`).join(" ");
    expect(ngramHashes(long).size).toBeGreaterThan(100); // would have thrown
    await expect(corpusEchoCheck(env.DB, long)).resolves.toEqual([]);
    // And it still HITS when a hash from a later chunk is present.
    const hashes = [...ngramHashes(long)];
    await env.DB.prepare(`INSERT OR IGNORE INTO echo_ngrams (hash) VALUES (?1)`).bind(hashes.at(-1)).run();
    expect((await corpusEchoCheck(env.DB, long)).map((i) => i.rule)).toEqual(["corpus_echo"]);
    await env.DB.prepare(`DELETE FROM echo_ngrams WHERE hash = ?1`).bind(hashes.at(-1)).run();
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

  it("p5-01: a SUPERSEDED draft is history, not precedent — it cannot cause a collision", async () => {
    await env.DB.prepare(
      `INSERT INTO items (dedup_key, source, external_id, category, fetched_at, source_url, payload, score, status)
       VALUES ('t:sup','edgar_8k','xsup','filing',?1,'https://s/sup','{}',2,'queued')`,
    ).bind(iso(NOW)).run();
    const item = await env.DB.prepare(`SELECT id FROM items WHERE dedup_key='t:sup'`).first<{ id: number }>();
    // regen_cycle 1: this row has been regenerated once, so cycle-0 drafts are
    // the discarded pass and cycle-1 drafts are its live answer.
    await env.DB.prepare(
      `INSERT INTO queue (item_id, archetype, draft_text, state, created_at, regen_cycle) VALUES (?1,'HALT','d','approved',?2,1)`,
    ).bind(item!.id, iso(NOW)).run();
    const q = await env.DB.prepare(`SELECT id FROM queue WHERE item_id=?1`).bind(item!.id).first<{ id: number }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO generations (queue_id, cycle, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
         VALUES (?1,0,'dry','discarded','DEADSKEL','DEADOPEN','valid',1,?2)`,
      ).bind(q!.id, iso(NOW)),
      env.DB.prepare(
        `INSERT INTO generations (queue_id, cycle, variant, text, skeleton_hash, opener_hash, status, attempt, created_at)
         VALUES (?1,1,'dry','live','LIVESKEL','LIVEOPEN','valid',2,?2)`,
      ).bind(q!.id, iso(NOW)),
    ]);

    // The shape the owner threw away must NOT block a new draft. Before p5-01
    // a regenerate deleted it, so this window only ever saw survivors; now it
    // survives on disk and has to be excluded deliberately.
    expect(await collisionCheck(env.DB, 0, "DEADSKEL", "DEADOPEN")).toEqual([]);
    // The row's LIVE draft still counts, so the gate is scoped, not disabled.
    expect((await collisionCheck(env.DB, 0, "LIVESKEL", "fresh")).map((i) => i.rule)).toEqual(["skeleton_collision"]);
    expect((await collisionCheck(env.DB, 0, "fresh", "LIVEOPEN")).map((i) => i.rule)).toEqual(["opener_collision"]);
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

describe("p5-04: the formatted date beat clears the validator", () => {
  const PRESS = {
    authority: "Bank of Japan",
    title: "Bank of Japan Accounts (July 31)",
    publishedIso: "2026-08-04T01:00:00.000Z",
  };

  it("'Published August 4.' passes, which is the whole justification for the change", () => {
    // The claim the p4 session asserted and this pins: payloadFacts stores a
    // month-day form alongside the full one, and dateCheck accepts a date with
    // no year, so the human rendering of a stored ISO validates.
    expect(numberCheck("Published August 4.", PRESS)).toEqual([]);
  });

  it("...and a date the payload does NOT state is still refused", () => {
    // The fix must not have widened what a draft may claim. It removes a slot;
    // it does not license new dates.
    const issues = numberCheck("Published August 5.", PRESS);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.rule).toBe("number");
  });

  it("the month-day form is genuinely derived from the payload's own timestamp", () => {
    const facts = payloadFacts(PRESS);
    expect(facts.dates.has("8-4")).toBe(true);
    expect(facts.dates.has("2026-8-4")).toBe(true);
  });
});

describe("cashtags pass the validator, invented ones still do not", () => {
  const PAYLOAD = { ticker: "DOCS", issuerName: "Doximity, Inc.", sharesTraded: 50000, insider: "Jane Doe" };

  it("a $ ticker the payload states is accepted", () => {
    // entityCheck already had a dedicated /\$([A-Z]{1,5})\b/ branch, so the
    // cashtag is the form it was built for rather than a new shape it has to
    // tolerate.
    expect(entityCheck("Jane Doe bought 50000 $DOCS", PAYLOAD)).toEqual([]);
  });

  it("an INVENTED cashtag is still refused, so the $ buys no new licence", () => {
    const issues = entityCheck("Jane Doe bought 50000 $TSLA", PAYLOAD);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.rule).toBe("entity");
    expect(issues[0]!.detail).toContain("$TSLA");
  });

  it("the cashtag is not read as a money figure", () => {
    // $DOCS has no digits, so numberCheck must not treat it as an unlicensed
    // dollar amount. Pinned because the two rules share the $ character.
    expect(numberCheck("Jane Doe bought 50000 $DOCS", PAYLOAD)).toEqual([]);
  });
});
