import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FEED from "./fixtures/form25-current.atom.xml?raw";
import DOC from "./fixtures/form25-primary.xml?raw";
import {
  draftForm25,
  FORM25_FEED,
  isExchangeInitiated,
  parseForm25Feed,
  parseForm25Xml,
  pollForm25,
  scoreForm25,
  SOURCE,
} from "../src/ingesters/form25";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixtures captured 2026-07-28T04:18Z. THESE are the parse contract.
const NOW = new Date("2026-07-28T05:00:00Z");

describe("parseForm25Feed (live fixture)", () => {
  const parsed = parseForm25Feed(FEED);

  it("collapses the exchange/issuer duplicates onto unique accessions", () => {
    expect(FEED.split("<entry>").length - 1).toBe(14);
    expect(parsed.length).toBeLessThan(14);
    expect(new Set(parsed.map((e) => e.accession)).size).toBe(parsed.length);
  });

  it("carries an archives dir and a UTC timestamp for every entry", () => {
    for (const e of parsed) {
      expect(e.dirUrl).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+$/);
      expect(e.filedIso).toMatch(/Z$/);
    }
  });
});

describe("parseForm25Xml (live fixture)", () => {
  it("reads the typed document exactly", () => {
    const doc = parseForm25Xml(DOC)!;
    expect(doc).toMatchObject({
      exchange: "Nasdaq Stock Market LLC",
      issuerName: "Churchill Capital Corp IX/Cayman",
      issuerCik: "0002006291",
      securityClass: "Class A Ordinary, Warrant, Unit",
      ruleProvision: "17 CFR 240.12d2-2(a)(1)",
      signatureDate: "2026-07-27",
    });
  });

  it("returns null without an exchange or issuer rather than a shell", () => {
    expect(parseForm25Xml("<html>maintenance</html>")).toBeNull();
    expect(parseForm25Xml("<notificationOfRemoval><issuer><cik>1</cik></issuer></notificationOfRemoval>")).toBeNull();
  });
});

describe("isExchangeInitiated — the whole editorial distinction", () => {
  const doc = parseForm25Xml(DOC)!;

  it("12d2-2(a) is the exchange striking the security", () => {
    expect(isExchangeInitiated(doc)).toBe(true);
    expect(scoreForm25(doc)).toBe(SCORE_POSTABLE);
  });

  it("12d2-2(c) is the issuer withdrawing voluntarily: routine, lake-only", () => {
    const voluntary = { ...doc, ruleProvision: "17 CFR 240.12d2-2(c)" };
    expect(isExchangeInitiated(voluntary)).toBe(false);
    expect(scoreForm25(voluntary)).toBe(SCORE_LOG_ONLY);
  });

  it("no rule provision means no claim about who acted", () => {
    expect(scoreForm25({ ...doc, ruleProvision: null })).toBe(SCORE_LOG_ONLY);
  });
});

describe("draftForm25", () => {
  it("names the exchange, the issuer and the class, with no em-dash", () => {
    const d = draftForm25(parseForm25Xml(DOC)!);
    expect(d).toBe(
      "Nasdaq Stock Market LLC filed to remove Churchill Capital Corp IX/Cayman (Class A Ordinary, Warrant, Unit) from listing, filed 2026-07-27",
    );
    expect(d).not.toContain("—");
    // Never a claim about why the company failed.
    expect(d.toLowerCase()).not.toMatch(/fraud|collapse|failed|scandal/);
  });
});

describe("DELISTING archetype", () => {
  const payload = {
    factLine: "Nasdaq Stock Market LLC filed to remove Churchill Capital Corp IX/Cayman from listing, filed 2026-07-27",
    exchange: "Nasdaq Stock Market LLC",
    issuerName: "Churchill Capital Corp IX/Cayman",
    securityClass: "Class A Ordinary, Warrant, Unit",
    ruleProvision: "17 CFR 240.12d2-2(a)(1)",
    exchangeInitiated: true,
  };

  it("renders fact + attribution and survives the publish guard", async () => {
    const { checkRegister } = await import("../src/templates/validate");
    const r = renderPost(ARCHETYPES.DELISTING, payload, { seed: "d25:1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per SEC");
    expect(checkRegister(r.text, "DELISTING")).toEqual([]);
  });

  it("the exchange-acted beats cannot render on a voluntary withdrawal", () => {
    const picked = pickBeat(
      ARCHETYPES.DELISTING,
      { ...payload, exchangeInitiated: false },
      { recentSkeletons: [], recentBeats: [] },
      0,
    );
    expect(picked?.beat.id).not.toBe("delist.thisIsTheDelisting");
    expect(picked?.beat.id).not.toBe("delist.exchangeActed");
  });
});

describe("pollForm25 end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const SEC = "https://www.sec.gov";
  const u = new URL(FORM25_FEED);

  it("feed -> stubs -> document -> graded delisting", async () => {
    fetchMock.get(SEC).intercept({ path: u.pathname + u.search }).reply(200, FEED);
    fetchMock
      .get(SEC)
      .intercept({ path: (p) => p.endsWith("/primary_doc.xml"), method: "GET" })
      .reply(200, DOC)
      .times(8);

    await pollForm25(env, NOW, newTickBudget(40));

    const detailed = await env.DB.prepare(
      "SELECT payload, score FROM items WHERE source = ?1 AND json_extract(payload,'$.phase') = 'detail' LIMIT 1",
    )
      .bind(SOURCE)
      .first<{ payload: string; score: number }>();
    expect(detailed).toBeTruthy();
    const p = JSON.parse(detailed!.payload) as Record<string, unknown>;
    expect(p.exchange).toBe("Nasdaq Stock Market LLC");
    expect(p.exchangeInitiated).toBe(true);
    expect(detailed!.score).toBe(SCORE_POSTABLE);
  });
});
