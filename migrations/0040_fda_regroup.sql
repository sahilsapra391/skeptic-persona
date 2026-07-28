-- FDA recall cards are now one per EVENT, not one per product record.
--
-- openFDA publishes one row per product, so a single recall arrives as many
-- near-identical rows. Measured in production 2026-07-28: 27 fda_drug_recall
-- items covering 12 real recall events, with one Bell Pharmaceuticals recall
-- alone accounting for 11 of them. Twenty-four of those had not yet reached
-- the approval queue.
--
-- Park the un-queued ones. They are superseded by the grouped items the new
-- ingester writes under a different dedup_key (event + classification +
-- reason), so nothing is lost from the lake and the owner sees one card per
-- recall instead of eleven.
--
-- Deliberately does NOT touch status='queued' rows: those were already sent
-- to the owner, and retracting a card he has already seen is worse than a
-- little redundancy. Score is left alone too -- it reflects FDA's own
-- classification, which is still true.
UPDATE items
   SET status = 'logged'
 WHERE source = 'fda_drug_recall'
   AND status = 'new';
