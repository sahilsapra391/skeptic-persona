-- PR-3: EDGAR 8-K ingester job. Cadence: 2 min inside the EDGAR acceptance
-- window (06:00-22:00 ET weekdays), 10 min outside, clamped to window open.
-- due_at is Date.toISOString() format exactly (see jobs table contract).
-- Note: ingesters insert sub-postable items with items.status='logged'
-- (added to the status vocabulary in this PR) so the notify-drain's 'new'
-- set stays bounded.
INSERT INTO jobs (name, due_at, cadence_profile, enabled)
VALUES ('edgar_8k', '2026-01-01T00:00:00.000Z', 'every_2m_us_0600_2200', 1);
