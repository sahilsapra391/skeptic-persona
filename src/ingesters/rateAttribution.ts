/**
 * Policy-rate attribution, keyed by the country string each rate source
 * publishes in its payload.
 *
 * THIS IS THE ONE AUTHORED COPY. Both the ingester (RATE_SOURCES) and the
 * RATE_DECISION archetype read it, so a bank's citation cannot say one thing
 * in the fact line and another in the rendered post. Restating the strings in
 * two places is exactly the drift that put a Senate citation on House filings.
 *
 * It lives in its own leaf module because the alternative creates a cycle:
 * templates/archetypes -> ingesters/rates -> pipeline/enqueue -> templates.
 * Nothing here imports anything.
 *
 * The map is CLOSED at authoring time. A payload picks a key; it can never
 * supply a citation. An unknown country resolves to null and the renderer
 * refuses to post rather than attributing a rate to the wrong institution.
 */
/**
 * NOTE ON INDIA. There is no `rate_rbi` source, so no India key belongs
 * here: a key for a country no ingester emits is dead code that reads as
 * coverage. RBI reaches this desk through `press_rbi`, which resolves
 * through PRESS_ATTRIBUTION as REGULATORY_NEWS. The owner's RBI exemplar is
 * filed under RATE_DECISION and cites "per MPC statement", which names no
 * institution at all -- the exact generic form #66 removed. Both are owner
 * calls: build the rate source, or re-file the exemplar.
 */
export const RATE_ATTRIBUTION: Readonly<Record<string, string>> = {
  Australia: "per the Reserve Bank of Australia",
  Brazil: "per Banco Central do Brasil",
  Canada: "per Bank of Canada",
  // "per ECB", not "per European Central Bank": the owner's RATE_DECISION
  // exemplar teaches the abbreviation, and sourcingCheck accepts ONLY the
  // declared string, so the long form rejected every draft that imitated the
  // exemplar we told the model to imitate. Same defect #66 fixed for press
  // attribution; the fix never travelled to rates.
  "Euro area": "per ECB",
  Israel: "per the Bank of Israel",
  Norway: "per Norges Bank",
  "South Africa": "per South African Reserve Bank",
  Sweden: "per Sveriges Riksbank",
  Switzerland: "per Swiss National Bank",
  "United Kingdom": "per Bank of England",
};
