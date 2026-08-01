-- Clear any 8-K grounding text that came from the generation fallback.
--
-- p4-01's fallback fetches items.source_url when raw_text is absent, and for
-- edgar_8k that URL is the EDGAR INDEX page: ~2,077 characters of navigation
-- chrome that licenses 78 numbers through groundingFacts and passes both the
-- prose and anchor gates, because it IS prose and it DOES name the company.
--
-- PR #75 stops that going forward by taking edgar_8k off the fallback. It
-- does not repair rows already cached, and it cannot: the capture job's
-- predicate is `raw_text IS NULL`, so a poisoned row is skipped forever.
--
-- The discriminator is raw_meta.document, which ONLY the dedicated capture
-- writes -- the fallback has no notion of which file inside the filing it
-- fetched, because it never opened the directory listing.
--
-- Measured before writing this: production currently holds ZERO rows with
-- raw_text of any kind, so today this is a no-op. It exists because the
-- window between p4-01 being live and #75 deploying is real, and a poisoned
-- row is permanent without it. Idempotent; safe to re-run.
UPDATE items
   SET raw_text = NULL, raw_meta = NULL
 WHERE source = 'edgar_8k'
   AND raw_text IS NOT NULL
   AND (raw_meta IS NULL OR json_extract(raw_meta, '$.document') IS NULL);
