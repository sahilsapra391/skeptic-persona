-- p4-01: grounded generation.
--
-- raw_text: the primary document's text, for the generation prompt. Two
-- writers: ingesters that already hold the bytes (press RSS descriptions),
-- and a one-time conditional fetch at generation for items without it
-- (cached here so a document is fetched at most once, ever).
-- raw_meta: JSON provenance — {url, fetchedAt, sha256, bytes, mode,
-- truncated}. mode is "ingest_rss" | "full" | "excerpt".
--
-- Additive only; existing rows read NULL and generation degrades to
-- payload + lake context.
ALTER TABLE items ADD COLUMN raw_text TEXT;
ALTER TABLE items ADD COLUMN raw_meta TEXT;
