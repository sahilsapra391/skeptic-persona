import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FEED from "./fixtures/schedule13d-current.atom.xml?raw";
import DOC from "./fixtures/schedule13d-primary.xml?raw";
import {
  BIG_STAKE_PCT,
  draft13,
  eventDateToIso,
  parse13Feed,
  parse13Xml,
  pollSchedule13,
  SCHEDULE_13D_FEED,
  SCHEDULE_13G_FEED,
  score13,
  SOURCE,
} from "../src/ingesters/schedule13d";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixtures captured 2026-07-28T01:03Z. THESE are the parse contract.
const NOW = new Date("2026-07-28T02:00:00Z");

describe("THE NAMING TRAP", () => {
  it("both feeds use SCHEDULE 13x, never the obvious SC 13x", () => {
    // Verified live: type=SC+13D returned ONE entry, type=SCHEDULE+13D
    // returned FORTY. A poller on the wrong spelling looks healthy — 200,
    // valid Atom, no error — while missing ~99% of filings.
    expect(SCHEDULE_13D_FEED).toContain("type=SCHEDULE+13D");
    expect(SCHEDULE_13G_FEED).toContain("type=SCHEDULE+13G");
    expect(SCHEDULE_13D_FEED).not.toContain("type=SC+13D");
  });
});

describe("parse13Feed (live fixture)", () => {
  const parsed = parse13Feed(FEED);

  it("collapses the (Filed by)/(Subject) duplicates onto unique accessions", () => {
    expect(FEED.split("<entry>").length - 1).toBe(40);
    expect(parsed.length).toBeLessThan(40);
    expect(new Set(parsed.map((e) => e.accession)).size).toBe(parsed.length);
  });

  it("extracts the form type so amendments are distinguishable", () => {
    expect(parsed.some((e) => e.formType.endsWith("/A"))).toBe(true);
    for (const e of parsed) {
      expect(e.formType).toMatch(/^SCHEDULE 13[DG](\/A)?$/);
      expect(e.dirUrl).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+$/);
    }
  });
});

describe("parse13Xml (live fixture)", () => {
  it("reads the cover page exactly", () => {
    const doc = parse13Xml(DOC)!;
    expect(doc).toMatchObject({
      issuerCik: "0001940674",
      issuerName: "SMX (Security Matters) Public Limited Company",
      cusip: "G8267K406",
      dateOfEvent: "07/23/2026",
      dateOfEventIso: "2026-07-23",
      previouslyFiled: false,
      topPercent: 18.5,
      topPersonName: "Haggai Alon",
    });
    expect(doc.persons[0]).toMatchObject({
      cik: "0002105917",
      type: "IN",
      aggregateAmountOwned: 201485,
      soleVotingPower: 201485,
      sharedVotingPower: 0,
    });
  });

  it("returns null rather than a half-parsed shell", () => {
    expect(parse13Xml("<html>maintenance</html>")).toBeNull();
    expect(parse13Xml("<edgarSubmission><issuerCIK>1</issuerCIK></edgarSubmission>")).toBeNull();
  });

  it("picks the LARGEST reported stake when several persons file together", () => {
    const twoPersons = DOC.replace(
      "</reportingPersonInfo>",
      `</reportingPersonInfo><reportingPersonInfo>
         <reportingPersonName>Bigger Holder LLC</reportingPersonName>
         <percentOfClass>44.4</percentOfClass>
         <aggregateAmountOwned>999.00</aggregateAmountOwned>
       </reportingPersonInfo>`,
    );
    const doc = parse13Xml(twoPersons)!;
    expect(doc.topPercent).toBe(44.4);
    expect(doc.topPersonName).toBe("Bigger Holder LLC");
  });
});

describe("eventDateToIso", () => {
  it("normalizes the cover page's MM/DD/YYYY and rejects impossible dates", () => {
    expect(eventDateToIso("07/23/2026")).toBe("2026-07-23");
    expect(eventDateToIso("02/30/2026")).toBeNull();
    expect(eventDateToIso("2026-07-23")).toBeNull();
    expect(eventDateToIso(null)).toBeNull();
  });
});

describe("score13", () => {
  const doc = parse13Xml(DOC)!;

  it("a stake we cannot size is never postable", () => {
    expect(score13({ ...doc, topPercent: null }, "SCHEDULE 13D")).toBe(SCORE_LOG_ONLY);
    expect(score13({ ...doc, topPersonName: null }, "SCHEDULE 13D")).toBe(SCORE_LOG_ONLY);
  });

  it("13D outranks 13G: intent beats passivity", () => {
    expect(score13({ ...doc, topPercent: BIG_STAKE_PCT }, "SCHEDULE 13D")).toBe(SCORE_AUTO_ALERT);
    expect(score13({ ...doc, topPercent: 6 }, "SCHEDULE 13D")).toBe(SCORE_POSTABLE);
    // A passive 13G at the same 6% is not news.
    expect(score13({ ...doc, topPercent: 6 }, "SCHEDULE 13G")).toBe(SCORE_LOG_ONLY);
    expect(score13({ ...doc, topPercent: 12 }, "SCHEDULE 13G")).toBe(SCORE_POSTABLE);
  });
});

describe("draft13", () => {
  it("states the holder, the size and the triggering date", () => {
    const doc = parse13Xml(DOC)!;
    const d = draft13(doc, "SCHEDULE 13D/A");
    expect(d).toBe(
      "Schedule 13D amendment: Haggai Alon reports 201,485 shares, 18.5% of SMX (Security Matters) Public Limited Company, event dated 07/23/2026",
    );
    expect(d).not.toContain("—");
  });
});

describe("OWNERSHIP_STAKE archetype", () => {
  const payload = {
    factLine: "Schedule 13D: Haggai Alon reports 201,485 shares, 18.5% of SMX",
    topPersonName: "Haggai Alon",
    issuerName: "SMX",
    topPercent: 18.5,
    dateOfEvent: "07/23/2026",
    isSchedule13D: true,
    isAmendment: false,
  };

  it("renders fact + attribution and survives the publish guard", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const r = renderPost(ARCHETYPES.OWNERSHIP_STAKE, payload, { seed: "s13:1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per SEC");
    expect(checkRegister(r.text, "OWNERSHIP_STAKE")).toEqual([]);
  });

  it("an amendment carries NO beat: it restates a position we may have posted", () => {
    const picked = pickBeat(
      ARCHETYPES.OWNERSHIP_STAKE,
      { ...payload, isAmendment: true },
      { recentSkeletons: [], recentBeats: [] },
      0,
    );
    expect(picked).toBeNull();
  });

  it("the 13D beat cannot render on a 13G", () => {
    const picked = pickBeat(
      ARCHETYPES.OWNERSHIP_STAKE,
      { ...payload, isSchedule13D: false },
      { recentSkeletons: [], recentBeats: ["stake.eventDate", "stake.coverPage", "stake.large"] },
      0,
    );
    expect(picked?.beat.id).not.toBe("stake.13dIsIntent");
  });
});

describe("pollSchedule13 end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const SEC = "https://www.sec.gov";

  it("feed -> stubs -> cover page -> graded item, recording the stake", async () => {
    for (const feed of [SCHEDULE_13D_FEED, SCHEDULE_13G_FEED]) {
      const u = new URL(feed);
      fetchMock.get(SEC).intercept({ path: u.pathname + u.search }).reply(200, FEED);
    }
    fetchMock
      .get(SEC)
      .intercept({ path: (p) => p.endsWith("/primary_doc.xml"), method: "GET" })
      .reply(200, DOC)
      .times(8);

    await pollSchedule13(env, NOW, newTickBudget(40));

    const detailed = await env.DB.prepare(
      "SELECT payload FROM items WHERE source = ?1 AND json_extract(payload,'$.phase') = 'detail' LIMIT 1",
    )
      .bind(SOURCE)
      .first<{ payload: string }>();
    expect(detailed).toBeTruthy();
    const p = JSON.parse(detailed!.payload) as Record<string, unknown>;
    expect(p.topPercent).toBe(18.5);
    expect(p.factLine).toContain("Haggai Alon");

    const fact = await env.DB.prepare("SELECT metric, value FROM lookback_facts WHERE source = ?1 LIMIT 1")
      .bind(SOURCE)
      .first<{ metric: string; value: number }>();
    expect(fact?.metric).toBe("stake_pct");
    expect(fact?.value).toBe(18.5);
  });
});
