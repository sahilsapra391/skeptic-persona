-- P2 PR-8: template engine.
-- Rotation ledger lives on the queue row we already INSERT (zero extra KV
-- writes): which skeleton variant and which beat this post used.
ALTER TABLE queue ADD COLUMN skeleton_id TEXT;
ALTER TABLE queue ADD COLUMN beat_id TEXT;
CREATE INDEX idx_queue_archetype_rotation ON queue(archetype, id DESC);

-- Archetype IDs previously collided: 8-K, Form 4 and congressional PTRs all
-- enqueued as 'FILING_ALERT', while halts, Fed and BLS all used 'WIRE'.
-- Rotation keyed on archetype would have treated a halt and a CPI print as
-- the same skeleton family. Split them to match docs/persona.md §8.
UPDATE queue SET archetype = 'FILING_8K'
  WHERE archetype = 'FILING_ALERT'
    AND item_id IN (SELECT id FROM items WHERE source = 'edgar_8k');
UPDATE queue SET archetype = 'FILING_FORM4'
  WHERE archetype = 'FILING_ALERT'
    AND item_id IN (SELECT id FROM items WHERE source = 'edgar_form4');
UPDATE queue SET archetype = 'CONGRESS_PTR'
  WHERE archetype = 'FILING_ALERT'
    AND item_id IN (SELECT id FROM items WHERE source = 'senate_ptr');
UPDATE queue SET archetype = 'HALT'
  WHERE archetype = 'WIRE' AND item_id IN (SELECT id FROM items WHERE source = 'halt');
UPDATE queue SET archetype = 'FED_PRESS'
  WHERE archetype = 'WIRE' AND item_id IN (SELECT id FROM items WHERE source = 'fed_press');
UPDATE queue SET archetype = 'MACRO_PRINT'
  WHERE archetype = 'WIRE' AND item_id IN (SELECT id FROM items WHERE source = 'bls');

-- Legacy payload backfill. Items ingested BEFORE this PR stored a
-- pre-rendered `draft` field; the new skeletons read `factLine`, so any
-- still-undrained row would fail to render. The drain query is
-- ORDER BY id LIMIT N, so one unrenderable row would head-of-line block its
-- entire source. Park them in the lake instead: they are stale news by now.
UPDATE items SET status = 'logged'
WHERE status = 'new'
  AND source IN ('edgar_form4', 'senate_ptr', 'bls', 'fed_press', 'halt', 'insider_cluster')
  AND json_extract(payload, '$.factLine') IS NULL
  AND json_extract(payload, '$.draft') IS NOT NULL;
