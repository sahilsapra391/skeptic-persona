-- P4-09: capture the (draft, final) pair at the moment the owner acts on it.
--
-- post_log already stores final_text. The DRAFT it was compared against was
-- not stored, on the assumption it could be re-derived from generations via
-- cards.chosen_variant. It cannot, safely:
--
--   resolveVariantText() selects `status = 'valid' ORDER BY attempt DESC
--   LIMIT 1`. A regeneration after posting appends a higher attempt, so a
--   pair re-derived tomorrow is not the pair the owner acted on today. It
--   would still LOOK like a valid pair, which is the failure mode this
--   project keeps paying for: wrong content read as right content.
--
-- So the draft is snapshotted, in the same atomic batch as final_text, and
-- never recomputed. edit_distance is stored alongside for the same reason —
-- it is a fact about two specific strings at one moment, not a view.
ALTER TABLE post_log ADD COLUMN draft_text TEXT;
-- 'commentary' | 'sharp' | 'dry' | 'template' — the variant actually copied.
ALTER TABLE post_log ADD COLUMN draft_variant TEXT;
-- Levenshtein distance between draft_text and final_text, in characters.
-- 0 means shipped verbatim. NULL means the pair was never captured (rows
-- written before this migration), which is DISTINCT from 0 and must stay so:
-- counting NULL as zero would report a perfect zero-edit rate on no data.
ALTER TABLE post_log ADD COLUMN edit_distance INTEGER;

-- AN EDIT IS NOT ALWAYS A VOICE SIGNAL (raised by the ingestion session, and
-- it is the sharpest objection to this whole loop). If the owner rewrites a
-- draft because the PAYLOAD was thin — the five-field press case, where
-- generation had almost nothing to say — then that pair does not teach the
-- model to write better. It teaches it to compensate for missing facts, which
-- is a fabrication pressure dressed up as a style lesson.
--
-- Distinguishing the two needs context the pair alone cannot carry, and both
-- of these are free at capture time. Nothing consumes them yet, on purpose:
-- the point is that they exist for the days that have already happened by the
-- time anyone asks the question. A loop that starts collecting late can never
-- answer it retrospectively.
ALTER TABLE post_log ADD COLUMN payload_field_count INTEGER;
ALTER TABLE post_log ADD COLUMN grounding_chars INTEGER;

-- The "posted, but I edited it" flow sends a force-reply prompt and stores its
-- message id, but not WHICH variant the prompt was about. The reply handler
-- would therefore have to read cards.chosen_variant — a mutable slot, and
-- exactly the bug review finding #3 closed on the tap side, where Copy A then
-- Copy B then answering A's prompt recorded B's text.
--
-- So the prompt pins its own subject: the variant AND the draft text as shown,
-- captured when the prompt is sent. The reply then needs to resolve nothing,
-- and the pair survives a regeneration that replaces the generations rows.
ALTER TABLE cards ADD COLUMN posted_prompt_variant TEXT;
ALTER TABLE cards ADD COLUMN posted_prompt_draft TEXT;
