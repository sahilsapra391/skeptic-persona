# Endpoint & platform verification — 2026-07-26 (pre-P1)

All checks ran live 2026-07-26 21:37–22:08 UTC (a Sunday: filing feeds
correctly showed Friday-dated newest entries; every "quiet" feed returned
200 and was confirmed healthy, not broken). Per repo discipline, each
ingester PR re-verifies its own endpoints at build time and records results
here.

## P1 sources

### SEC EDGAR 8-K — works, better than planned
- **PR-3 re-verification:** live fixture captured 2026-07-27T00:57Z into
  `test/fixtures/edgar-8k-current.atom.xml` (40 entries: 39 8-K + 1 8-K/A;
  item lines present in every summary; structure unchanged from the
  2026-07-26 check). The fixture is the parse contract.
- **Paging verified live 2026-07-27T02:26Z:** `count=100` returns 100
  entries; `start=100&count=100` (page 2) returns 100 more. The ingester
  polls `count=100` and fetches one bounded second page on suspected
  window overflow.
- **`type=` filter is PREFIX-match** (review-verified 2026-07-27T01:13Z:
  `type=485` returned 485APOS/485BPOS/485BXT; `type=S-1` returned S-1MEF),
  so `type=8-K` can deliver 8-K12B/8-K12G3/8-K15D5. Those fail the strict
  title regex by design → CIK unparsed → clamped to log-only (never drafted
  with unparsed fields).
- `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&...&output=atom` → 200.
  **Item numbers are embedded in each entry's `<summary>`** ("Item 5.02: …"),
  so acceptance→items-known needs zero extra requests. Regex: `/Item (\d+\.\d+):/`.
- Fallbacks: `<ACCESSION>-index-headers.html` exposes SGML `<ITEMS>` tags;
  EFTS `efts.sec.gov/LATEST/search-index?forms=8-K&dateRange=custom&...`
  returns `_source.items` as an array (dedupe hits on `adsh` — per-document,
  not per-filing); `data.sec.gov/submissions/CIK##########.json` has
  `recent.items` as a comma-joined string.
- Quirks: Content-Type lies (Atom + index.json served as text/html); feed
  `<updated>` is ET-offset while submissions API is UTC-Zulu; `count=` caps
  the page (poll fast enough on busy days); declared UA mandatory, ≤10 req/s
  (policy page verified).
- EDGAR acceptance window ~06:00–22:00 ET weekdays (filings accepted after
  17:30 ET are disseminated but dated next business day); near-zero new 8-Ks
  on weekends — as reported in the verification run. Drives the
  `*_us_0600_2200` cadence window.

### SEC EDGAR Form 4 — works
- **PR-4 re-verification (2026-07-27T03:04–03:06Z):** live fixtures captured —
  `test/fixtures/form4-current.atom.xml` (40 entries: 38 `4` + 2 `4/A`),
  `form4-dir-index.json` (single filer-named ownership XML, exactly as the
  2026-07-26 check found), `form4-derivative-only.xml` (Doximity/Tangney,
  CEO award, empty nonDerivativeTable), `form4-nonderivative.xml`
  (Loop/Sams, director, absent isOfficer/officerTitle elements). Fixtures
  are the parse contract. `count=100` + `start=100&count=100` paging
  verified live for `type=4` (100+100 entries). Cluster source-link pattern
  `action=getcompany&CIK=<cik>&type=4` verified 200.
- `...action=getcurrent&type=4&output=atom` → 200. Each filing appears ≥2×
  per page (one entry per reporting owner + issuer) — dedup on accession from
  `<id>`. `type=4` also returns 4/A (distinguishable via `<category term>`).
- Ownership XML filename is filer-chosen (`wk-form4_*.xml`, `rdgdoc.xml`, …):
  fetch `<dir>/index.json`, pick the `.xml`. All needed tags verified live
  (`transactionCoding>transactionCode`, `transactionAmounts>transactionShares>value`,
  `postTransactionAmounts>sharesOwnedFollowingTransaction>value`, officer
  flags, separate derivative/non-derivative tables). Leaf values wrapped in
  `<value>`; footnote-only elements exist; booleans mixed `1/0` and
  `true/false`; absent optionals are absent, not empty.
- Volume (EFTS counts): 315 filings Fri 2026-07-24; 1,414 for that week.

### House Clerk PTRs — works, daily-batch latency
- `2026FD.zip` (52 KB, ETag + Last-Modified served) → contains `2026FD.txt`
  (tab-delimited w/ header) + `2026FD.xml` (UTF-8 BOM). Fields: Prefix, Last,
  First, Suffix, FilingType, StateDst, Year, FilingDate (M/D/YYYY, no
  leading zeros, no time), DocID. FilingType `P` = PTR.
- PDF URL: `/public_disc/ptr-pdfs/<Year>/<DocID>.pdf`. E-filed (8-digit
  200xxxxx DocIDs) are text-layer but **RC4-128 encrypted with empty user
  password** — extractor must decrypt. 7-digit DocIDs likely scanned.
- ZIP rebuilds ~once per weekday ~13:00 UTC → bulk path is daily-granularity.
  Intra-day probe candidate: POST `ViewMemberSearchResult` (HTML fragment,
  worked live; refresh cadence unknown — PR-5 instruments both paths).

### Senate eFD — works end-to-end from curl
- 3-step handshake verified: GET `/search/home/` (csrftoken cookie + LB
  cookie + hidden `csrfmiddlewaretoken` from HTML — two DIFFERENT values) →
  POST agreement (`prohibition_agreement=1`, Referer required) → 302 +
  `sessionid` → POST `/search/report/data/` (X-CSRFToken header = cookie
  value, `report_types=[11]`) → DataTables JSON, rows are positional string
  arrays, report UUID regexed from the `<a href>` in element [3].
- Electronic PTRs render as HTML tables at `/search/view/ptr/<uuid>/`
  (columns: #, Transaction Date, Owner, Ticker, Asset Name, Asset Type,
  Type, Amount, Comment). `/search/view/paper/<uuid>/` = scanned GIFs → log-only.
- Trap: missing session returns **503 "Site Under Maintenance"** — treat as
  session-reset signal, not an outage.

### Fed press RSS — works
- `press_all.xml` → 200; per-item `<category>` present, so one feed covers
  all categories (per-category feeds also exist). UTF-8 BOM; CDATA-wrapped
  fields; `guid` = URL = dedupe key. FOMC statement URL pattern
  `monetary<YYYYMMDD>a.htm` confirmed; statement body is clean, diffable
  HTML; calendar page parseable (year lives only in the panel heading).
- Cloudflare-fronted, edge-cached → 5 min polling floor is honest.

### BLS — works, mechanics differ from plan
- Machine-readable calendar: `https://www.bls.gov/schedule/news_release/bls.ics`
  (VEVENTs with `TZID=US-Eastern` through 2026-12-30, ETag served). The old
  `2026_sched.htm` pattern is dead.
- Release pages (`cpi.nr0.htm` etc.): 200 with identifying UA, **403 with
  default UA**; **no cache headers** → watcher content-diffs on the USDL
  number / headline month inside `<div class="normalnews"><PRE>`.
- Flat files unusable in the hot path (48.8 MB, Range ignored, mtimes lag).
  API v2: unregistered 25 q/day, free key 500 q/day (annual renewal) —
  confirmation pass only.
- MUST re-verify from deployed Workers egress (Akamai may treat datacenter
  IPs differently). Next live arms: JOLTS 8/4, NFP 8/7 08:30 ET, CPI 8/12 08:30 ET.

### Trading halts — works
- Nasdaq Trader RSS `rss.aspx?feed=tradehalts` → 200; `ttl=1` (60 s polling
  sanctioned); capped at 25 items; cross-market (NASDAQ + AMEX seen);
  UTF-8 BOM; real timestamp = `ndaq:HaltDate` + `ndaq:HaltTime` (ET, no TZ
  marker; `pubDate` is date-only). Resumption fields mutate the same event.
- NYSE `nyse.com/api/trade-halts/current/download` → 200; CSV behind
  octet-stream; **snapshot not event stream** (diff consecutive pulls);
  Cloudflare edge cache 300 s → 5 min floor; triple-quote artifact in names.
- Halt-code legend verified; auto-post allowlist: T1 T2 T5 T6 T8 T12 H4 H9
  H10 H11 LUDP LUDS MWC1-3 O1.

## Platform limits

### Cloudflare (free plan, docs verified via `<url>/index.md`)
- Workers: 100k req/day, **10 ms CPU**/invocation (also for cron), 50
  external subrequests/invocation, cron wall-clock max 15 min.
- **Cron triggers: 5 per ACCOUNT** → single `* * * * *` + D1 job table.
- **KV: 1,000 writes/day** (different keys) → dedup CANNOT live in KV; D1
  it is. Same-key writes 1/s.
- D1: 5M rows read/day, 100k rows written/day, 500 MB/db. "Rows read" =
  rows SCANNED → UNIQUE index on dedup key is mandatory.

### Threads API (all official Meta docs; `.md` twins curl-able)
- **Free** (zero pricing/billing mentions across the docs); NOT unlimited:
  **250 posts + 1,000 replies + 100 deletes per rolling 24 h** per profile;
  quota endpoint `GET /{user-id}/threads_publishing_limit`.
- Hosts `graph.threads.net` / `graph.threads.com`, v1.0. OAuth authorize on
  `threads.net`; short-lived 1 h → long-lived 60 days
  (`th_exchange_token`) → refresh (`th_refresh_token`, token must be ≥24 h
  old); expired tokens are unrecoverable → weekly refresh job + alert.
- No App Review to post to own profile (owner account = Threads Tester).
  Public mentions / keyword search / webhooks need Advanced Access (+
  verified business for webhooks) — not needed for pilot.
- Text ≤500 chars (emoji = UTF-8 byte count); `link_attachment` (TEXT posts
  only) carries the source URL outside the text budget; ≤5 unique links.
  Images pulled from public URLs (R2): JPEG/PNG ≤8 MB, ≤10:1 aspect, render
  ≤1440 px; `alt_text` ≤1000 chars. `auto_publish_text=true` = one-call text
  post; media containers: wait ~30 s or poll container `status`.
- Reads free at standard access for own account: replies/conversations,
  insights (likes/replies/reposts/quotes/views/clicks/followers).
- Error quirk: invalid token → **HTTP 500** with JSON `error.code` 190.
- Policy: no automated-account label exists on Threads; repetitive content
  is a named Meta spam signal (template rotation = compliance); PRE-LAUNCH:
  read the Threads API License Terms inside the dev console (not readable
  logged-out) re: consumer ToU "no commercial purpose" clause.

## Global source adds verified (existence-level, for P5/P7)
- **P5 adds:** RBA RSS (single-item feed — poll often), ABS SDMX API
  (keyless typed CSV), BoK English RSS, BoC press RSS + Valet API (overnight
  target 2.25% verified), StatCan Daily Atom (`0-eng.atom`), BCB SGS API
  (Selic 14.25% verified; use explicit date ranges, `/ultimos/N` returns
  forward-dated rows), Banxico SIE (needs free token) + English statements
  page, CBRT English press Atom (**dedicated MPC feed is 7 months stale —
  filter the general feed by title**), SARB publications RSS (category
  filter; relative links), ASX Markit Digital JSON (keyless,
  `isPriceSensitive`; undocumented API → schema-drift alarm; check ASX terms
  before posting), HKEX titleSearchServlet JSON (double-encoded `result`).
- **Skips (named reasons):** RBNZ + Saudi Tadawul (403 to non-browser
  clients), MAS (no feed, non-numeric policy instrument), SEDAR+ (no free
  machine-readable route).
- **P7 deferrals:** TDnet (Japanese-only HTML), Korea OpenDART/KIND, Japan
  e-Stat CPI (free appId + metadata mapping), Norges Bank (Norwegian-only
  feed), CBRT EVDS (moved to evds3, key required).
