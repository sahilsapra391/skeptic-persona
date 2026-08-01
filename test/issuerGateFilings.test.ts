import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { gateContext, issuerGate, MIN_AUTHORITATIVE_ROWS } from "../src/ingesters/issuers";
import FORM4_SRC from "../src/ingesters/form4.ts?raw";
import SCHED13_SRC from "../src/ingesters/schedule13d.ts?raw";
import FORM144_SRC from "../src/ingesters/form144.ts?raw";

// The gate proven on 8-K in #62/#64, now applied to the other three filing
// sources. These are the high-volume lanes: Form 4, Schedule 13D/G, Form 144.

async function seed(cik: number, exchange: string, float: number | null) {
  await env.DB.prepare(
    `INSERT INTO issuers (cik, name, ticker, exchange, public_float, updated_at)
     VALUES (?1, 'CO', 'C', ?2, ?3, ?4)
     ON CONFLICT(cik) DO UPDATE SET exchange=excluded.exchange, public_float=excluded.public_float`,
  )
    .bind(cik, exchange, float, new Date().toISOString())
    .run();
}

async function makeAuthoritative() {
  for (let i = 0; i < MIN_AUTHORITATIVE_ROWS + 10; i += 500) {
    const batch = [];
    for (let j = i; j < Math.min(i + 500, MIN_AUTHORITATIVE_ROWS + 10); j++) {
      batch.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO issuers (cik, name, ticker, exchange, public_float, updated_at)
           VALUES (?1, 'FILLER', 'F', 'Nasdaq', 9000000000, ?2)`,
        ).bind(700000 + j, new Date().toISOString()),
      );
    }
    await env.DB.batch(batch);
  }
}

const NOW = new Date();

describe("issuerGate", () => {
  it("suppresses a small listed issuer and passes a large one", async () => {
    await seed(11111, "Nasdaq", 20_000_000);
    await seed(22222, "NYSE", 8_000_000_000);
    expect((await issuerGate(env as never, 11111, await gateContext(env as never, NOW))).keep).toBe(false);
    expect((await issuerGate(env as never, 22222, await gateContext(env as never, NOW))).keep).toBe(true);
  });

  it("passes an unknown issuer until the reference covers the market", async () => {
    expect((await issuerGate(env as never, 98765, await gateContext(env as never, NOW))).reason).toBe("reference_unavailable");
    await makeAuthoritative();
    expect((await issuerGate(env as never, 98765, await gateContext(env as never, NOW))).reason).toBe("not_in_reference");
  });

  it("passes a CIK it cannot parse rather than suppressing on nonsense", async () => {
    await makeAuthoritative();
    // A blank issuerCik means the filing did not parse one. That is a reason
    // to not CLAIM anything about the issuer, not a reason to suppress.
    const blank = await issuerGate(env as never, "", await gateContext(env as never, NOW));
    expect(blank.keep).toBe(true);
    expect(blank.reason).toBe("no_issuer_cik");
  });
});

describe("the gate is wired to the ISSUER, never to the filer", () => {
  // Every one of these forms carries a second CIK identifying a PERSON:
  // rptOwnerCik on Form 4, reportingPersonCIK on Schedule 13. Passing one of
  // those would look a human up in a table of companies, find nothing, and --
  // since absence became evidence in #64 -- suppress the entire source.
  //
  // A behavioural test cannot see this: both CIKs are strings and both
  // "work". Reading the call site is the only way to pin it.
  it.each([
    ["form4", FORM4_SRC],
    ["schedule13d", SCHED13_SRC],
    ["form144", FORM144_SRC],
  ])("%s gates on doc.issuerCik", (_mod, src) => {
    expect(src).toContain("issuerGate(env, doc.issuerCik, ctx)");
    // The context MUST be built outside the per-filing path: referenceHealth
    // scans the whole issuers table, so calling it per filing read ~12,000
    // rows each time and would have burned a 5M/day D1 budget in minutes.
    expect(src).toContain("await gateContext(env, now)");
    expect(src).not.toMatch(/issuerGate\(env,[^)]*now\)/);
    expect(src).not.toMatch(/issuerGate\(env,\s*doc\.cik/);
    expect(src).not.toMatch(/issuerGate\(env,\s*\w*[oO]wner/);
  });
});

describe("the insider cluster obeys the same gate as the filings it summarises", () => {
  it("does not fire an auto-alert for an issuer whose own Form 4s were suppressed", async () => {
    // Reported by the p4 session's adversarial review and reproduced here.
    // checkCluster inserts at SCORE_AUTO_ALERT with status 'new', so it is
    // the loudest thing this lane emits. Three insiders buying a $20M-float
    // Nasdaq microcap inside the window produced three correctly-silenced
    // Form 4s AND one auto-alert interrupt about that same issuer -- exactly
    // the under-float bucket the gate exists to hold.
    await seed(33333, "Nasdaq", 20_000_000);
    await makeAuthoritative();

    const ctx = await gateContext(env as never, NOW);
    const gate = await issuerGate(env as never, 33333, ctx);
    expect(gate).toEqual({ keep: false, reason: "below_float" });

    // The guard is the gate result, so the assertion that matters is that
    // the cluster is reached only when the gate lets the filing through.
    const src = FORM4_SRC.slice(FORM4_SRC.indexOf("if (won && owner"));
    expect(src).toMatch(/if \(gate\.keep\) \{\s*await checkCluster/);
  });
});
