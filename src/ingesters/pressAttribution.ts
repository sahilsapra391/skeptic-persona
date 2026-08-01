/**
 * Regulator-press attribution, keyed by the authority string each press
 * source writes into its payload (regulatoryPress.ts PRESS_SOURCES; the CFTC
 * enforcement relay lane emits the same payloads).
 *
 * THIS IS THE ONE AUTHORED COPY, same law as RATE_ATTRIBUTION: the archetype
 * resolves the citation THROUGH this map from payload.authority, so a payload
 * picks a key and can never supply citation text. Unknown authority -> null
 * -> the renderer refuses rather than guessing, and checkRegister with the
 * payload accepts ONLY the one resolved string — "per SEC" on a CFTC order
 * fails the register.
 *
 * Why the generic "per the issuing authority" had to go: the owner's
 * REGULATORY_NEWS exemplars all cite the named body ("per SEC", "per CFTC",
 * "per FTC"). The first live generation (queue #918, 2026-08-01) faithfully
 * imitated them and the validator rejected all five attribution-bearing
 * variants for citing a body the archetype never declared — a guaranteed
 * template fallback on every press item. See
 * docs/verification/2026-08-01-p4-00-deploy-truth.md §5.
 *
 * Leaf module: imports nothing (templates/archetypes imports this; a cycle
 * through ingesters would deadlock module init).
 */
export const PRESS_ATTRIBUTION: Readonly<Record<string, string>> = {
  SEC: "per SEC",
  CFTC: "per CFTC",
  FTC: "per FTC",
  "UK FCA": "per the FCA",
  "European Commission": "per the European Commission",
  "Bank of Japan": "per the Bank of Japan",
};
