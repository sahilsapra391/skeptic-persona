-- CONGRESS_PTR now resolves its attribution from payload.chamber, because the
-- archetype serves both chambers and used to hardcode "per Senate eFD".
-- Existing Senate rows predate the field; without this backfill any re-render
-- of them (the RAG fallback path re-renders from payload) would fail closed
-- and the item would silently stop producing a draft.
--
-- Idempotent: only fills rows where the field is absent.
UPDATE items
   SET payload = json_set(payload, '$.chamber', 'senate')
 WHERE source = 'senate_ptr'
   AND json_valid(payload)
   AND json_extract(payload, '$.chamber') IS NULL;
