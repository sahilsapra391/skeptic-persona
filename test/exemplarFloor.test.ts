import { describe, expect, it } from "vitest";
import { FLOOR_GATES, payloadFacts } from "../src/rag/validate";
import { OWNER_EXEMPLARS } from "../src/rag/stylepack";

// THE MISSING CROSS-CHECK.
//
// stylepack.test.ts runs the owner exemplars through checkRegister and
// fitsInPost. Nothing in test/ has ever run them through the FABRICATION FLOOR
// — entityCheck and numberCheck — which is the gate their imitations actually
// face. So the voice authority and the floor are two independently maintained
// specifications of the same output, and no test compares them.
//
// stylepack.test.ts states the principle itself, and then applies it to one
// gate of the two:
//
//   "The pack's examples are the model's imitation targets. An example that
//    fails the register would teach the model to fail it too."
//
// The sentence stays true with "the floor" substituted for "the register".
//
// See docs/verification/2026-08-01-exemplars-vs-floor.md.

/**
 * A payload shaped like the one each archetype actually receives, carrying the
 * entities its exemplars name. Deliberately GENEROUS: the point is to catch
 * constructions the floor rejects even when every real entity is licensed, not
 * to rediscover that a mismatched payload rejects things.
 */
/**
 * A payload that licenses the exemplar's OWN FACTS, derived from the exemplar
 * rather than hand-written.
 *
 * The distinction this test needs: an exemplar quoting "$15,001 - $50,000"
 * fails numberCheck against any payload that does not carry those figures, and
 * that is a FIXTURE MISMATCH, not a defect. (I made exactly that mistake twice
 * while finding this bug — first with placeholder tickers, then with one shared
 * payload for seven exemplars.) So every number and date the exemplar states is
 * licensed here, leaving the gates to judge the LANGUAGE.
 *
 * Names are deliberately NOT licensed. If they were, entityCheck would pass
 * trivially and the test would assert nothing — which is the whole defect class
 * it exists to catch.
 */
function payloadLicensingFactsOf(text: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  let n = 0;
  // Percent claims need a PERCENT-KEYED field: payloadFacts reads the key
  // name, not the value, so a rate under `fig0` licenses nothing.
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*%/g)) {
    payload[`pct${n++}`] = Number(m[1]!.replace(/,/g, ""));
  }
  // Scale suffixes ("$4.2M") resolve the way the real payload states them.
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([MBK])\b/g)) {
    const mult = m[2] === "B" ? 1e9 : m[2] === "M" ? 1e6 : 1e3;
    payload[`fig${n++}`] = Number(m[1]!.replace(/,/g, "")) * mult;
  }
  // Times ride verbatim, as a timestamp field would carry them.
  for (const m of text.matchAll(/\b\d{1,2}:\d{2}\b/g)) payload[`at${n++}`] = m[0];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    payload[`fig${n++}`] = Number(m[0].replace(/,/g, ""));
  }
  // The exemplar's own ticker placeholder is one of ITS facts.
  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) payload[`ticker${n++}`] = m[1];
  // Institutions the exemplar names as its subject ("RBI", "MPC", "ECB").
  // Emphasis words in caps are NOT licensed - that distinction is the point,
  // and "BUYING" staying flagged is a real finding, not a fixture gap.
  for (const inst of ["RBI", "MPC", "ECB", "BOE", "BOJ"]) {
    if (text.includes(inst)) payload[`authority${n++}`] = inst;
  }
  const WORDS: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, dozen: 12,
  };
  const TENS: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  for (const m of text.matchAll(/\b([A-Za-z]+)-([A-Za-z]+)\b/g)) {
    const t = TENS[m[1]!.toLowerCase()], u = WORDS[m[2]!.toLowerCase()];
    if (t !== undefined && u !== undefined) payload[`word${n++}`] = t + u;
  }
  for (const m of text.matchAll(/\b([A-Za-z]+)\b/g)) {
    const v = WORDS[m[1]!.toLowerCase()] ?? TENS[m[1]!.toLowerCase()];
    if (v !== undefined) payload[`word${n++}`] = v;
  }
  const MONTHS: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  for (const m of text.matchAll(/\b([A-Z][a-z]+)\s+(\d{1,2})\b/g)) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    if (mo) payload[`date${n++}`] = `2026-${String(mo).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return payload;
}

const COVERED_ARCHETYPES = new Set(OWNER_EXEMPLARS.map((e) => e.archetype));

/**
 * Exemplars that genuinely fail the floor today, listed so they are VISIBLE
 * and CANNOT GROW. Each is real work, not an excuse:
 *
 *  - "All Code" (INSIDER_CLUSTER): `all` is in no lexicon, so this is a plain
 *    two-token capitalised phrase and entityCheck is right to want it in the
 *    payload. It never will be — `inPayload` matches the contiguous phrase.
 *    My verification doc previously called this "the same shape" as
 *    "One House". It is not, and that was wrong.
 *  - "BUYING" (FILING_FORM4): an ALL-CAPS emphasis word, not an entity. The
 *    all-caps rule exists to catch invented tickers and institutions, and it
 *    has no way to tell those from emphasis.
 *
 *  - "per ECB" (RATE_DECISION): RATE_ATTRIBUTION declares "per European
 *    Central Bank"; the exemplar teaches the abbreviation. sourcingCheck
 *    allows only the declared string, so a draft imitating the exemplar is
 *    rejected. This is the SAME bug PRESS_ATTRIBUTION fixed for regulatory
 *    press in #66 — exemplars taught "per CFTC" while the archetype declared
 *    "per the issuing authority" — and it was never applied to rates.
 *  - "per MPC statement" (RATE_DECISION): India is absent from
 *    RATE_ATTRIBUTION entirely, so an RBI decision resolves to null and, per
 *    that module's own comment, "the renderer refuses to post".
 *
 * The last two live in src/ingesters/rateAttribution.ts, which is the
 * ingestion session's lane; they are flagged to them rather than fixed here.
 *
 * Each needs its own false-positive corpus or its owner's sign-off, which is
 * why all four are named here rather than patched into the lexicons alongside
 * a fabrication-gate change.
 */
const KNOWN_FLOOR_CONFLICTS = [
  { archetype: "INSIDER_CLUSTER", detail: 'entity: name "All Code" does not appear in the payload' },
  { archetype: "FILING_FORM4", detail: 'entity: all-caps token "BUYING" does not appear in the payload' },
  // "per ECB" REMOVED 2026-08-02: RATE_ATTRIBUTION now declares the
  // abbreviation the owner's exemplar teaches (#101), so this no longer
  // trips. The staleness guard named it the moment the fix landed, which is
  // the whole point of the guard -- the fix forces its own cleanup.
  //
  // "per MPC statement" STAYS: there is no rate_rbi source, and that
  // exemplar also names no institution at all. Both are owner calls.
  { archetype: "RATE_DECISION", detail: 'sourcing: attribution "per MPC statement" is not one of our records' },
  // B-01.4. These two name a REAL issuer that IS in the real payload
  // (`company`, straight off the EDGAR feed), and both exemplars validate
  // CLEAN against it — checked directly against the stored payloads from
  // docs/packs/2026-08-06-earnings-payloads.md before install.
  //
  // They trip only in THIS harness, and by its own design: the fixture
  // deliberately withholds names, because licensing them would make
  // entityCheck pass trivially and the test assert nothing. So the conflict
  // is between the exemplar and the fixture, not between the exemplar and the
  // floor. Listed rather than fixed, because the fixture's refusal to license
  // names is the property worth keeping.
  { archetype: "EARNINGS_EVENT", detail: 'entity: name "York Water Co" does not appear in the payload' },
  { archetype: "EARNINGS_EVENT", detail: 'entity: name "Whitehawk Therapeutics" does not appear in the payload' },
] as const;

/** Exact match on BOTH archetype and the whole detail string.
 *
 *  The first version matched with `detail.includes(k)` on a bare substring,
 *  which meant the admission could still absorb a NEW failure: a fabricated
 *  exemplar reading "All Code Red Capital filed it." is a genuine entityCheck
 *  rejection, and it was swallowed by the "All Code" entry with the suite
 *  staying green. The list existed to stop exactly that, and matched loosely
 *  enough to do the opposite. */
const isKnownConflict = (archetype: string, rule: string, detail: string): boolean =>
  KNOWN_FLOOR_CONFLICTS.some((k) => k.archetype === archetype && k.detail === `${rule}: ${detail}`);

describe("owner exemplars vs the fabrication floor", () => {
  const covered = OWNER_EXEMPLARS.filter((e) => COVERED_ARCHETYPES.has(e.archetype));

  it("enumerates the gates from the PIPELINE's list, not a copy of it", () => {
    // The whole point. If someone adds a gate to the floor, this test starts
    // applying it to the exemplars automatically — which is the only version
    // that stays true. A hand-maintained second list is how the two specs
    // drifted apart in the first place.
    expect(FLOOR_GATES.length).toBeGreaterThanOrEqual(5);
    expect(FLOOR_GATES.map((g) => g.name)).toContain("entityCheck");
    expect(FLOOR_GATES.map((g) => g.name)).toContain("numberCheck");
  });

  it("covers EVERY exemplar, and the guard notices if that narrows", () => {
    // `covered.length > 0` was the old guard and it could not detect a
    // narrowed archetype set — which is exactly how two live failures stayed
    // hidden. Pin both totals instead.
    expect(covered.length).toBe(OWNER_EXEMPLARS.length);
    expect(COVERED_ARCHETYPES.size).toBeGreaterThanOrEqual(8);
  });

  it("the known-conflict list has not GROWN", () => {
    // The list is an admission, not a suppression. If a new exemplar trips the
    // floor, it must show up as a failure rather than be quietly added here.
    const tripped = new Set<string>();
    for (const ex of OWNER_EXEMPLARS) {
      const payload = payloadLicensingFactsOf(ex.text);
      const facts = payloadFacts(payload);
      for (const issue of FLOOR_GATES.flatMap((g) => g.run(ex.text, payload, facts))) {
        tripped.add(isKnownConflict(ex.archetype, issue.rule, issue.detail)
          ? `${ex.archetype}: ${issue.rule}: ${issue.detail}`
          : `UNKNOWN: ${ex.archetype}: ${issue.rule}: ${issue.detail}`);
      }
    }
    expect([...tripped].filter((t) => t.startsWith("UNKNOWN"))).toEqual([]);
  });

  it("the known-conflict list has not gone STALE either", () => {
    // The list can rot in BOTH directions and the test above only catches one.
    // When the ingestion session's #101 lands, "per ECB" stops tripping — and
    // an entry that no longer describes a real conflict is a standing excuse
    // for a problem that no longer exists. Asserting every entry still trips
    // makes the fix force its own cleanup.
    const stillTripping = new Set<string>();
    for (const ex of OWNER_EXEMPLARS) {
      const payload = payloadLicensingFactsOf(ex.text);
      const facts = payloadFacts(payload);
      for (const issue of FLOOR_GATES.flatMap((g) => g.run(ex.text, payload, facts))) {
        if (isKnownConflict(ex.archetype, issue.rule, issue.detail)) {
          stillTripping.add(`${ex.archetype}|${issue.rule}: ${issue.detail}`);
        }
      }
    }
    const stale = KNOWN_FLOOR_CONFLICTS.filter((k) => !stillTripping.has(`${k.archetype}|${k.detail}`));
    expect(stale, "remove these from KNOWN_FLOOR_CONFLICTS — they no longer trip").toEqual([]);
  });

  for (const [i, ex] of covered.entries()) {
    it(`E${i + 1} ${ex.archetype} survives the FLOOR: "${ex.text.slice(0, 38).replace(/\n/g, " ")}..."`, () => {
      const payload = payloadLicensingFactsOf(ex.text);
      const facts = payloadFacts(payload);
      const issues = FLOOR_GATES.flatMap((g) => g.run(ex.text, payload, facts))
        .filter((x) => !isKnownConflict(ex.archetype, x.rule, x.detail));
      expect(issues.map((x) => `${x.rule}: ${x.detail}`)).toEqual([]);
    });
  }

  // The specific construction, pinned separately so the cause stays legible
  // after the exemplar bank changes.
  it("a sentence-initial capitalised verb before a month is not a proper name", () => {
    const payload = payloadLicensingFactsOf("Filed July 18. Disclosed July 18. Reported June 3.");
    const facts = payloadFacts(payload);
    for (const line of ["Filed July 18.", "Disclosed July 18.", "Reported June 3."]) {
      const issues = FLOOR_GATES.flatMap((g) => g.run(line, payload, facts));
      expect(issues.map((x) => x.detail), line).toEqual([]);
    }
  });

  // The opposite direction, so the fix cannot be "stop checking names".
  it("still rejects a genuinely fabricated multi-token name", () => {
    const payload = payloadLicensingFactsOf("Josh Gottheimer reported it");
    const facts = payloadFacts(payload);
    expect(FLOOR_GATES.flatMap((g) => g.run("Josh Gottheimer reported it", payload, facts)).length).toBeGreaterThan(0);
  });
});

describe("the name/date boundary is dateCheck's predicate, not a reading of it", () => {
  const F4 = {
    issuer: "Lockheed Martin", issuerCik: "0000936468", ticker: "LMT",
    insiderName: "Jane Roe", shares: 25000, filedAt: "2026-07-18T19:50:00Z",
    tradeDate: "2026-06-03",
  };
  const floor = (t: string) => {
    const facts = payloadFacts(F4);
    return FLOOR_GATES.flatMap((g) => g.run(t, F4, facts));
  };

  it("HIGH: a comma let a fabricated member through BOTH gates", () => {
    // isNameShaped used `[\s.,]*\d{1,2}` while DATE_PHRASE_RE uses `\s+`. On a
    // comma entityCheck stood down believing dateCheck owned the phrase, and
    // dateCheck never claimed it — so this complete, correctly-sourced,
    // postable draft named a member present in no payload field, and NOTHING
    // objected.
    const poison = 'Form 4: Jane Roe (CFO) bought 25,000 shares of $LMT at $14.20, open market, Code P, per SEC.\nSenator May, 2 days after the trade.\nA grant is a paycheck. A P is a decision.';
    expect(floor(poison).length).toBeGreaterThan(0);
  });

  it("EVERY separator is caught, whichever gate owns it", () => {
    // The division of labour is the point: dateCheck claims the space, period
    // and newline forms (it reads "May. 2" as an abbreviated date); entityCheck
    // claims the rest. Asserting on the FLOOR rather than on entityCheck alone,
    // because which gate catches it is an implementation detail and whether
    // anything catches it is not.
    for (const sep of [", ", "; ", " (", " - ", ". ", "\n", " "]) {
      expect(floor(`Senator May${sep}2 days after the trade.`).length, JSON.stringify(sep)).toBeGreaterThan(0);
    }
  });

  it("all 24 name+month combinations are caught", () => {
    const MONTHS_LIST = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    for (const m of MONTHS_LIST) {
      for (const title of ["Senator", "Congressman"]) {
        expect(floor(`${title} ${m}, 2 days after the trade.`).length, `${title} ${m}`).toBeGreaterThan(0);
      }
    }
  });

  it("MEDIUM, the opposite direction: the ordinal form dateCheck accepts", () => {
    // The near-miss predicate rejected "July 4th", which DATE_PHRASE_RE
    // accepts — wrong in BOTH directions from one careful reading.
    for (const t of ["Filed July 4th.", "Filed July 4th, 2026.", "Filed July 18.", "Reported June 3."]) {
      expect(floor(t).filter((i) => i.rule === "entity").map((i) => i.detail), t).toEqual([]);
    }
  });
});
