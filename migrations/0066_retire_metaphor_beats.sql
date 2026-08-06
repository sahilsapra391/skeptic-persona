-- Owner ruling on D-31, 2026-08-06: the metaphor-group beats retire from the
-- beat library and from signed text, and the pending cards carrying them
-- re-render.
--
-- Retired beats: form4.decision ("An award is compensation. A P is a
-- decision."), n144.noticeNotTrade ("A 144 is the intent. The Form 4 is the
-- receipt.", the line the owner named at persona.md:112 and
-- archetypes.ts:240), cluster.reason ("The cluster is the fact. The reason
-- isn't filed.").
--
-- FOUR pending cards carry one, not the eleven previously reported. The 11
-- figure counted DRAFTS in a 400-row recent sample regardless of state; the
-- pending count is 4. Corrected here rather than in prose only.
--
-- The replacement text below is exactly what renderPost produces for each
-- row's own payload under the retired-beat library, verified before this
-- migration was written. Skeletons are unchanged where the render kept them.
--
-- The 44 EXPIRED cards carrying these beats are deliberately untouched:
-- expired means declined (owner ruling 6), and rewriting a declined card's
-- text would falsify the record of what was actually shown.
--
-- The Telegram messages already in the owner's chat still show the retired
-- line; this corrects the record of truth that every downstream card is built
-- from, and does not reach back into a sent message.

UPDATE queue SET
  draft_text = 'Linker John R (EVP, Finance and CFO): bought 7,500 CMCO at ~$19.67 ($148K) on 2026-07-31, stake now 7,500 shares, per SEC Form 4' || char(10) || char(10) || '5 days from trade to filing.',
  beat_id = 'form4.lag'
WHERE id = 998 AND state = 'pending' AND beat_id = 'form4.decision';

UPDATE queue SET
  draft_text = 'CASPER MARC N (Officer, Director) filed notice of a proposed sale of 15,000 shares, $8.5M of THERMO FISHER SCIENTIFIC INC. on or after 08/05/2026, per SEC Form 144' || char(10) || char(10) || 'This one is filed before the sale, not after.',
  beat_id = 'n144.beforeNotAfter'
WHERE id = 1080 AND state = 'pending' AND beat_id = 'n144.noticeNotTrade';

-- $59.2M -> $59.19M is the uniform-2dp rounding law (D-30) applying on
-- re-render, not a changed fact. Recorded because the visible number moves.
UPDATE queue SET
  draft_text = 'Andreas Bechtolsheim (10% Stockholder) filed notice of a proposed sale: 300,000 shares ($59.19M) of Arista Networks, Inc., per SEC Form 144' || char(10) || char(10) || 'The broker is named in the filing.',
  beat_id = 'n144.brokerNamed',
  skeleton_id = 'n144.whoWhat'
WHERE id = 1139 AND state = 'pending' AND beat_id = 'n144.noticeNotTrade';

UPDATE queue SET
  draft_text = 'Klein Michael Stuart (See Remarks): bought 350,000 XIIIU at ~$10.00 ($3.5M) on 2026-08-03, stake now 350,000 shares, per SEC Form 4' || char(10) || char(10) || 'Code P. Bought, not granted.',
  beat_id = 'form4.codeP'
WHERE id = 1144 AND state = 'pending' AND beat_id = 'form4.decision';
