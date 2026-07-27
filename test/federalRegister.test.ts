import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import FIXTURE from "./fixtures/federal-register-presidential.json?raw";
import {
  draftPresidentialDoc,
  FEDREG_PRESIDENTIAL,
  isCeremonial,
  parsePresidentialDocs,
  pollFederalRegister,
  scorePresidentialDoc,
  SOURCE,
  type PresidentialDoc,
} from "../src/ingesters/federalRegister";
import { newTickBudget } from "../src/lib/budget";
import { SCORE_AUTO_ALERT, SCORE_LOG_ONLY, SCORE_POSTABLE } from "../src/lib/db";
import { ARCHETYPES } from "../src/templates/archetypes";
import { pickBeat, renderPost } from "../src/templates/render";

// Live fixture captured 2026-07-27T22:52Z. THIS is the parse contract.
const NOW = new Date("2026-07-27T23:00:00Z");
const parsed = parsePresidentialDocs(FIXTURE);

describe("parsePresidentialDocs (live fixture)", () => {
  it("parses the executive order with its number and both dates", () => {
    const eo = parsed.find((d) => d.number === "14415")!;
    expect(eo).toMatchObject({
      kind: "Executive Order",
      publicationDate: "2026-07-23",
      signingDate: "2026-07-20",
      signingLagDays: 3, // signed Monday, published Thursday
    });
    expect(eo.title).toContain("Defense Supply Chains");
    expect(eo.htmlUrl).toMatch(/^https:\/\/www\.federalregister\.gov\/documents\//);
  });

  it("carries the tariff proclamations that are the whole point of this source", () => {
    const tariffs = parsed.filter((d) => /Imposing Additional Duties/i.test(d.title));
    expect(tariffs.length).toBeGreaterThan(0);
    expect(tariffs[0]?.kind).toBe("Proclamation");
    expect(tariffs[0]?.number).toBeTruthy();
  });

  it("drops records missing an identifier, title, date or link", () => {
    const rows = { results: [{ document_number: "", title: "x", publication_date: "2026-07-27", html_url: "u" }] };
    expect(parsePresidentialDocs(JSON.stringify(rows))).toEqual([]);
    const noUrl = { results: [{ document_number: "1", title: "x", publication_date: "2026-07-27", html_url: "" }] };
    expect(parsePresidentialDocs(JSON.stringify(noUrl))).toEqual([]);
  });
});

describe("isCeremonial — a selection heuristic, never a claim", () => {
  const make = (title: string, kind = "Proclamation"): PresidentialDoc => ({
    documentNumber: "1",
    title,
    kind,
    number: "1",
    publicationDate: "2026-07-23",
    signingDate: "2026-07-20",
    htmlUrl: "https://www.federalregister.gov/documents/x",
    signingLagDays: 3,
  });

  it("filters the ceremonial proclamations in the live fixture", () => {
    const ceremonial = parsed.filter(isCeremonial).map((d) => d.title);
    expect(ceremonial).toContain("Made in America Week, 2026");
    expect(ceremonial).toContain("Captive Nations Week, 2026");
  });

  it("never filters a substantive proclamation", () => {
    const tariff = parsed.find((d) => /Imposing Additional Duties/i.test(d.title))!;
    expect(isCeremonial(tariff)).toBe(false);
  });

  it("only ever applies to proclamations", () => {
    // An EO titled like a ceremony is still an EO.
    expect(isCeremonial(make("National Something Week, 2026", "Executive Order"))).toBe(false);
    expect(isCeremonial(make("National Something Week, 2026"))).toBe(true);
  });
});

describe("scorePresidentialDoc", () => {
  it("EOs and determinations alert; substantive proclamations post; ceremony is lake-only", () => {
    const eo = parsed.find((d) => d.kind === "Executive Order")!;
    expect(scorePresidentialDoc(eo)).toBe(SCORE_AUTO_ALERT);

    const tariff = parsed.find((d) => /Imposing Additional Duties/i.test(d.title))!;
    expect(scorePresidentialDoc(tariff)).toBe(SCORE_POSTABLE);

    const week = parsed.find((d) => d.title === "Made in America Week, 2026")!;
    expect(scorePresidentialDoc(week)).toBe(SCORE_LOG_ONLY);
  });
});

describe("draftPresidentialDoc", () => {
  it("uses the document's own title and number, with no interpretation", () => {
    const eo = parsed.find((d) => d.number === "14415")!;
    const d = draftPresidentialDoc(eo);
    expect(d).toContain("Executive Order 14415:");
    expect(d).toContain("signed 2026-07-20");
    expect(d).not.toContain("—");
  });
});

describe("POLICY_ACTION archetype", () => {
  const payload = {
    factLine: "Executive Order 14415: Securing America's Defense Supply Chains, signed 2026-07-20",
    title: "Securing America's Defense Supply Chains",
    kind: "Executive Order",
    number: "14415",
    documentNumber: "2026-15000",
    publicationDate: "2026-07-23",
    signingDate: "2026-07-20",
    signingLagDays: 3,
  };

  it("renders fact + attribution + a gated beat", () => {
    const r = renderPost(ARCHETYPES.POLICY_ACTION, payload, { seed: "p:1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("per Federal Register");
    expect(r.text).not.toContain("—");
  });

  it("the publication-lag beat needs a genuinely long gap", () => {
    const quick = pickBeat(ARCHETYPES.POLICY_ACTION, payload, { recentSkeletons: [], recentBeats: [] }, 0);
    expect(quick?.beat.id).not.toBe("policy.publicationLag");
    const slow = pickBeat(
      ARCHETYPES.POLICY_ACTION,
      { ...payload, signingLagDays: 12 },
      { recentSkeletons: [], recentBeats: [] },
      0,
    );
    expect(slow?.beat.id).toBe("policy.publicationLag");
  });
});

describe("pollFederalRegister end-to-end", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  const FR = "https://www.federalregister.gov";
  const u = new URL(FEDREG_PRESIDENTIAL);

  it("ingests, applies the selection gate, records the signing lag", async () => {
    fetchMock.get(FR).intercept({ path: u.pathname + u.search }).reply(200, FIXTURE);
    await pollFederalRegister(env, NOW, newTickBudget(30));

    const rows = await env.DB.prepare("SELECT status, score FROM items WHERE source = ?1").bind(SOURCE).all<{ status: string; score: number }>();
    expect(rows.results.length).toBe(parsed.length);
    // Ceremony captured but never queued.
    expect(rows.results.some((r) => r.status === "logged")).toBe(true);
    expect(rows.results.some((r) => r.score === SCORE_AUTO_ALERT)).toBe(true);

    const facts = await env.DB.prepare("SELECT metric, value FROM lookback_facts WHERE source = ?1 LIMIT 1")
      .bind(SOURCE)
      .first<{ metric: string; value: number }>();
    expect(facts?.metric).toBe("signing_to_publication_days");
  });

  it("a failing endpoint counts a failure and ingests nothing new", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(SOURCE).first<{ n: number }>();
    fetchMock.get(FR).intercept({ path: u.pathname + u.search }).reply(500, "err");
    await pollFederalRegister(env, NOW, newTickBudget(30));
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?1").bind(SOURCE).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
