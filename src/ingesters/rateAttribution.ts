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
export const RATE_ATTRIBUTION: Readonly<Record<string, string>> = {
  Australia: "per the Reserve Bank of Australia",
  Brazil: "per Banco Central do Brasil",
  Canada: "per Bank of Canada",
  "Euro area": "per European Central Bank",
  Israel: "per the Bank of Israel",
  Norway: "per Norges Bank",
  "South Africa": "per South African Reserve Bank",
  Sweden: "per Sveriges Riksbank",
  Switzerland: "per Swiss National Bank",
  "United Kingdom": "per Bank of England",
};
