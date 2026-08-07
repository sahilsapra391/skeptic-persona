import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import S1_FIX from "./fixtures/edgar-s1.atom.fixture?raw";
import DFAN_FIX from "./fixtures/edgar-dfan14a.atom.fixture?raw";
import { formFeedUrl, parseEdgarFormFeed } from "../src/ingesters/edgarForms";
import {
  S1_FORMS,
  SOURCE as S1_SOURCE,
  amendmentHistory,
  amendmentHistoryFor,
  factLineFor as s1FactLine,
  stageOf,
} from "../src/ingesters/s1Ipo";
import {
  CONTEST_FORMS,
  SOURCE as PROXY_SOURCE,
  factLineFor as proxyFactLine,
  isSelfDeclaredContest,
  priorStake,
} from "../src/ingesters/proxyContest";
import { SOURCE as SCHEDULE13_SOURCE } from "../src/ingesters/schedule13d";
import { insertItem, SCORE_LOG_ONLY } from "../src/lib/db";

const NOW = new Date("2026-08-07T22:00:00Z");

describe("edgarForms: the shared feed parser", () => {
  it("parses every entry in the real S-1 feed", () => {
    const entries = parseEdgarFormFeed(S1_FIX);
    expect(entries.length).toBeGreaterThan(20);
    for (const e of entries) {
      expect(e.cik).toMatch(/^\d{10}$/);
      expect(e.accession).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      expect(e.indexUrl).toContain("sec.gov/Archives");
      expect(e.company.length).toBeGreaterThan(0);
    }
  });

  it("MERGES the Filed by / Subject pair instead of dropping half of it", () => {
    // Measured live: every DFAN14A came back TWICE, once under the activist
    // and once under the target. Deduping to whichever arrived first is
    // non-deterministic, and if `Subject` won, p5-31's cross-reference would
    // look up the TARGET's CIK and silently find nothing.
    const entries = parseEdgarFormFeed(DFAN_FIX);
    // Six feed rows collapse to three real filings.
    expect(entries.length).toBe(3);
    for (const e of entries) {
      expect(e.role, `${e.company} should be the filing party`).toBe("filed_by");
      expect(e.subjectCik, `${e.company} should carry its target`).toMatch(/^\d{10}$/);
      expect(e.subjectCompany).toBeTruthy();
      // The two sides are different parties, which is the point.
      expect(e.subjectCik).not.toBe(e.cik);
    }
    const toms = entries.find((e) => e.company.startsWith("TOMS Capital"));
    expect(toms?.subjectCompany).toBe("Voya Financial, Inc.");
    expect(toms?.cik).toBe("0001743937");
  });

  it("skips titles it cannot attribute rather than guessing", () => {
    expect(parseEdgarFormFeed("<feed><entry><title>garbage</title></entry></feed>")).toEqual([]);
    expect(parseEdgarFormFeed("")).toEqual([]);
  });

  it("URL-encodes the form type, so 'S-1/A' and 'DEF 14A' survive", () => {
    expect(formFeedUrl("S-1/A")).toContain("type=S-1%2FA");
    expect(formFeedUrl("DEF 14A")).toContain("type=DEF%2014A");
  });
});

describe("p5-30: the IPO / S-1 lane", () => {
  it("maps each form to the moment in the deal it represents", () => {
    expect(stageOf("S-1")).toBe("registration");
    expect(stageOf("S-1/A")).toBe("amendment");
    expect(stageOf("424B4")).toBe("priced");
    expect(stageOf("424B3")).toBe("priced");
    expect(S1_FORMS).toEqual(["S-1", "S-1/A", "424B4"]);
  });

  it("counts amendments from OUR LAKE and says 'at least', never a bare total", () => {
    // The count is what we have seen, not EDGAR's history. Copy that implied
    // completeness would be claiming knowledge we do not have.
    const e = { company: "Ionetix Corp", cik: "0002108121" } as never;
    expect(s1FactLine(e, "registration", 0)).toBe("Ionetix Corp filed an S-1 registration statement, per SEC");
    expect(s1FactLine(e, "amendment", 2)).toContain("at least 3 amendments on record");
    expect(s1FactLine(e, "priced", 0)).toContain("final prospectus (424B4)");
    // Every line carries attribution, per the structural law.
    for (const stage of ["registration", "amendment", "priced"] as const) {
      expect(s1FactLine(e, stage, 1)).toContain(", per SEC");
    }
  });

  it("amendmentHistory counts only THIS issuer's amendments", async () => {
    const mk = (cik: string, stage: string, ext: string) =>
      insertItem(
        env.DB,
        {
          source: S1_SOURCE,
          externalId: ext,
          category: "ipo_registration",
          eventAt: "2026-08-01T00:00:00.000Z",
          sourceUrl: `https://www.sec.gov/Archives/${ext}`,
          payload: { cik, stage, company: "X" },
          score: SCORE_LOG_ONLY,
          status: "logged",
        },
        NOW,
      );
    await mk("0000000001", "amendment", "a-1");
    await mk("0000000001", "amendment", "a-2");
    await mk("0000000001", "registration", "a-3");
    await mk("0000000002", "amendment", "b-1");

    expect((await amendmentHistory(env.DB, "0000000001")).amendments).toBe(2);
    expect((await amendmentHistory(env.DB, "0000000002")).amendments).toBe(1);
    expect((await amendmentHistory(env.DB, "0000009999")).amendments).toBe(0);
  });

  it("D-82: the batched lookup answers for EVERY cik in one query", async () => {
    // The per-entry version timed out on the lane's first live poll: 31
    // entries meant 31 sequential D1 round trips inside one budget, and
    // `sec_s1` recorded TimeoutError after inserting a partial batch.
    //
    // Seeds its OWN rows. vitest-pool-workers gives each `it` an isolated
    // storage snapshot, so reading rows another test inserted returns nothing
    // — which is exactly how this test failed first, and it looked like a SQL
    // bug rather than a test one.
    const mk = (cik: string, ext: string) =>
      insertItem(
        env.DB,
        {
          source: S1_SOURCE,
          externalId: ext,
          category: "ipo_registration",
          eventAt: "2026-08-01T00:00:00.000Z",
          sourceUrl: `https://www.sec.gov/Archives/${ext}`,
          payload: { cik, stage: "amendment", company: "X" },
          score: SCORE_LOG_ONLY,
          status: "logged",
        },
        NOW,
      );
    await mk("0000000001", "batch-1");
    await mk("0000000001", "batch-2");
    await mk("0000000002", "batch-3");

    const m = await amendmentHistoryFor(env.DB, ["0000000001", "0000000002", "0000009999", "0000000001"]);
    expect(m.get("0000000001")!.amendments).toBe(2);
    expect(m.get("0000000002")!.amendments).toBe(1);
    // An issuer with no amendments is ABSENT from the GROUP BY, not zero. It
    // must still get an entry, or the caller reads undefined as a count.
    expect(m.get("0000009999")).toEqual({ amendments: 0, firstSeenIso: null });
    // Deduped: four inputs, three distinct issuers.
    expect(m.size).toBe(3);
  });

  it("the batched lookup is safe on an empty list", async () => {
    expect((await amendmentHistoryFor(env.DB, [])).size).toBe(0);
  });
});

describe("p5-31: the proxy-contest lane", () => {
  it("excludes DEF 14A, the routine annual meeting", () => {
    // Measured the same minute: DEF 14A 26 entries against DEFC14A 1. The
    // contested forms self-identify; the routine one is pure volume.
    expect(CONTEST_FORMS).toEqual(["DEFC14A", "PREC14A", "DFAN14A"]);
    expect(CONTEST_FORMS).not.toContain("DEF 14A");
  });

  it("knows which forms declare themselves contested", () => {
    expect(isSelfDeclaredContest("DEFC14A")).toBe(true);
    expect(isSelfDeclaredContest("PREC14A")).toBe(true);
    expect(isSelfDeclaredContest("DFAN14A")).toBe(false);
    expect(isSelfDeclaredContest("DEF 14A")).toBe(false);
  });

  describe("the 13D cross-reference", () => {
    beforeAll(async () => {
      // Shaped exactly like a real sec_schedule13 payload, including the
      // group-filing case the percent-selection logic exists for.
      await insertItem(
        env.DB,
        {
          source: SCHEDULE13_SOURCE,
          externalId: "xref-1",
          category: "ownership",
          eventAt: "2026-08-04T00:00:00.000Z",
          sourceUrl: "https://www.sec.gov/Archives/xref-1",
          payload: {
            issuerName: "ETHAN ALLEN INTERIORS INC",
            formType: "SCHEDULE 13D",
            dateOfEventIso: "2026-08-04",
            topPercent: 9.9,
            topPersonName: "SOMEONE ELSE",
            persons: [
              { name: "SOMEONE ELSE", cik: "0009999999", percentOfClass: 9.9 },
              { name: "DGB Investment, Inc.", cik: "0001472520", percentOfClass: 4.1 },
            ],
          },
          score: SCORE_LOG_ONLY,
          status: "logged",
        },
        NOW,
      );
    });

    it("matches on CIK and reports THIS filer's percent, not the group's top", async () => {
      // On a group filing the top holder is a different person. Reporting
      // their stake as this filer's would be a fabrication with a citation
      // attached, which is the worst shape a number can take here.
      const m = await priorStake(env.DB, "0001472520");
      expect(m.matched).toBe(true);
      expect(m.percent).toBe(4.1);
      expect(m.percent).not.toBe(9.9);
      expect(m.issuerName).toBe("ETHAN ALLEN INTERIORS INC");
    });

    it("returns no match for a filer we have never seen", async () => {
      const m = await priorStake(env.DB, "0001743937");
      expect(m.matched).toBe(false);
      expect(m.percent).toBeNull();
    });

    it("the fact line names the target, and only claims a stake when one exists", async () => {
      const entry = parseEdgarFormFeed(DFAN_FIX).find((e) => e.cik === "0001472520")!;
      expect(entry).toBeTruthy();

      const withStake = proxyFactLine(entry, await priorStake(env.DB, "0001472520"));
      expect(withStake).toContain("DGB Investment, Inc. filed");
      expect(withStake).toContain("regarding ETHAN ALLEN INTERIORS INC");
      expect(withStake).toContain(", per SEC");
      expect(withStake).toContain("4.1% of ETHAN ALLEN INTERIORS INC");

      // No match: the sentence simply stops. It must not hint at a stake.
      const without = proxyFactLine(entry, { matched: false, issuerName: null, percent: null, dateOfEventIso: null });
      expect(without).toContain("regarding ETHAN ALLEN INTERIORS INC");
      expect(without).not.toContain("Schedule 13D");
      expect(without).not.toContain("%");
    });
  });
});

describe("both lanes are DISCOVERY until an archetype exists", () => {
  it("neither scores above log-only, and neither enqueues", async () => {
    // There is no IPO or PROXY_CONTEST archetype and no exemplar bank. The
    // gate refuses generation when a bank is empty, so a postable score here
    // would produce a voiceless template card — the exact defect B-08 spent a
    // block removing. Asserted against the shipped source.
    for (const mod of ["s1Ipo", "proxyContest"]) {
      const src = await import(`../src/ingesters/${mod}?raw`).then((m) => (m as { default: string }).default);
      expect(src, `${mod} must not score postable`).not.toContain("SCORE_POSTABLE");
      expect(src, `${mod} must not auto-alert`).not.toContain("SCORE_AUTO_ALERT");
      expect(src, `${mod} must not enqueue`).not.toContain("enqueueForApproval");
      expect(src).toContain("SCORE_LOG_ONLY");
    }
    expect(S1_SOURCE).toBe("sec_s1");
    expect(PROXY_SOURCE).toBe("sec_proxy_contest");
  });
});
