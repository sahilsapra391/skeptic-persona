-- P3: regulator press releases (UK FCA, European Commission).
-- Live-verified 2026-07-28T02:32Z. Note the EU Commission's working RSS is
-- /commission/presscorner/api/rss — the obvious /rss.xml paths return the
-- SPA shell (HTML) with a 200, and /info/rss/news_en.xml 404s.
INSERT OR IGNORE INTO jobs (name, due_at, cadence_profile, enabled, priority) VALUES
  ('press_fca',            '2026-07-28T00:00:00.000Z', 'hourly', 1, 50),
  ('press_eu_commission',  '2026-07-28T00:00:00.000Z', 'hourly', 1, 50);
