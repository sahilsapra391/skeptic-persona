-- P2 go-live: retire every draft rendered BEFORE the template engine.
-- These carry em-dashes and no attribution (persona.md §6), have no rotation
-- provenance, and are stale news besides. Approving one after POSTING_ENABLED
-- flips would publish a draft that violates the signed voice doc, so they are
-- expired rather than left tappable. Their items stay in the lake.
UPDATE queue SET state = 'expired', decided_at = datetime('now')
WHERE state = 'pending' AND skeleton_id IS NULL;

UPDATE items SET status = 'expired'
WHERE status = 'queued'
  AND id IN (SELECT item_id FROM queue WHERE state = 'expired' AND skeleton_id IS NULL);
