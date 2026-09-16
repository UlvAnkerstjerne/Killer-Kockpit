-- Killer Kockpit — Google Marketing Storage
--
-- Tables:
--   gsc_daily          — Search Console daily site totals
--   gsc_queries        — Search Console top queries per day
--   gsc_pages          — Search Console top pages per day
--   ga4_daily          — GA4 property daily totals
--   ga4_traffic_sources — GA4 session source/medium breakdown per day
--   ga4_landing_pages  — GA4 landing page breakdown per day
--
-- Security:
--   RLS enabled on all tables. ZERO authenticated or anon policies.
--   All reads/writes go through server actions and sync processes using
--   createServiceClient(). Server actions enforce getCurrentUser() →
--   canAccessMarketing() → hasMarketingPermission() before any query.
--   PostgREST cannot access these tables from any browser session.
--
-- Institutional sync model:
--   These tables hold shared company-wide Marketing data — no user_id column.
--   integration_sync_state rows for GSC/GA4 use user_id IS NULL, matching
--   the Meta institutional pattern. The OAuth credential owner is resolved at
--   sync time via the GOOGLE_MARKETING_CREDENTIAL_USER_ID env variable.
--   The existing partial unique index integration_sync_state_institutional_unique
--   (added in 019_meta_foundation) already covers user_id IS NULL rows.
--
-- Sync state keys (for integration_sync_state.integration):
--   gsc_daily:{site_url}
--   gsc_queries:{site_url}
--   gsc_pages:{site_url}
--   ga4_daily:{property_id}
--   ga4_traffic_sources:{property_id}
--   ga4_landing_pages:{property_id}
--
-- Data types:
--   clicks/impressions/sessions/users: integer  — counts fit well within 32-bit
--   ctr:    numeric(8,6)  — fraction e.g. 0.031200, matches Meta convention
--   position: numeric(6,2) — average position; two decimal places meaningful
--   page_views: integer
--
-- Period-over-period comparisons are derived at query time from daily rows.
-- No separate comparison storage is needed.

-- ── gsc_daily ──────────────────────────────────────────────────────────────────
--
-- One row per (site_url, date). Daily aggregate across all queries and pages.
-- Used for top-line Search Console KPIs and period-over-period comparison.
--
-- site_url: exact URL as registered in Search Console, e.g.:
--   'https://killerkebab.com/'  (URL-prefix property)
--   'sc-domain:killerkebab.com' (domain property)
-- The sync process determines the correct form via sites.list().

CREATE TABLE gsc_daily (
  site_url    text    NOT NULL,
  date        date    NOT NULL,
  clicks      integer,
  impressions integer,
  ctr         numeric(8,6),   -- fraction, e.g. 0.031200
  position    numeric(6,2),   -- average position
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_url, date)
);

CREATE INDEX gsc_daily_date_idx
  ON gsc_daily(date DESC);

-- ── gsc_queries ────────────────────────────────────────────────────────────────
--
-- Top organic search queries per (site_url, date).
-- Synced with dimensions=['date','query'], rowLimit up to 100 per day.
-- Used for "Top Keywords" breakdown and query-level trend analysis.

CREATE TABLE gsc_queries (
  site_url    text    NOT NULL,
  date        date    NOT NULL,
  query       text    NOT NULL,
  clicks      integer,
  impressions integer,
  ctr         numeric(8,6),
  position    numeric(6,2),
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_url, date, query)
);

CREATE INDEX gsc_queries_site_date_idx
  ON gsc_queries(site_url, date DESC);

-- ── gsc_pages ──────────────────────────────────────────────────────────────────
--
-- Top organic landing pages per (site_url, date).
-- Synced with dimensions=['date','page'], rowLimit up to 100 per day.
-- Used for "Top Pages" breakdown and content performance tracking.

CREATE TABLE gsc_pages (
  site_url    text    NOT NULL,
  date        date    NOT NULL,
  page        text    NOT NULL,   -- full URL as returned by GSC
  clicks      integer,
  impressions integer,
  ctr         numeric(8,6),
  position    numeric(6,2),
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_url, date, page)
);

CREATE INDEX gsc_pages_site_date_idx
  ON gsc_pages(site_url, date DESC);

-- ── ga4_daily ──────────────────────────────────────────────────────────────────
--
-- One row per (property_id, date). Daily aggregate across all sessions and users.
-- Used for top-line GA4 KPIs and period-over-period comparison.
--
-- property_id: bare numeric ID as used in the GA4 Data API, e.g. '333149501'.
--   Path construction (properties/{property_id}) is handled in sync code only.
--
-- other_metrics_json: captures additional metrics returned by the API (e.g.
--   engagement rate, bounce rate, average session duration) without schema changes.
--   Stored as {metric_name: numeric_value}.

CREATE TABLE ga4_daily (
  property_id        text    NOT NULL,
  date               date    NOT NULL,
  sessions           integer,
  total_users        integer,
  new_users          integer,
  page_views         integer,   -- screenPageViews metric
  other_metrics_json jsonb,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, date)
);

CREATE INDEX ga4_daily_date_idx
  ON ga4_daily(date DESC);

-- ── ga4_traffic_sources ────────────────────────────────────────────────────────
--
-- Session source/medium breakdown per (property_id, date).
-- Synced with dimensions=['date','sessionSource','sessionMedium'].
-- Used for "Traffic Sources" view and organic vs. paid vs. direct analysis.
--
-- session_source: e.g. 'google', 'instagram', '(direct)'
-- session_medium: e.g. 'organic', 'cpc', 'referral', 'none'
-- Users are NOT additive across source/medium rows (deduplication); use ga4_daily
-- for authoritative user totals.

CREATE TABLE ga4_traffic_sources (
  property_id    text    NOT NULL,
  date           date    NOT NULL,
  session_source text    NOT NULL,
  session_medium text    NOT NULL,
  sessions       integer,
  total_users    integer,
  new_users      integer,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, date, session_source, session_medium)
);

CREATE INDEX ga4_traffic_sources_property_date_idx
  ON ga4_traffic_sources(property_id, date DESC);

-- ── ga4_landing_pages ──────────────────────────────────────────────────────────
--
-- Landing page breakdown per (property_id, date).
-- Synced with dimensions=['date','landingPage'].
-- Used for "Landing Pages" view and per-URL acquisition performance.
--
-- landing_page: path + optional query string as returned by GA4, e.g. '/menu/'.
--   Does NOT include scheme/host — GA4 returns relative paths.

CREATE TABLE ga4_landing_pages (
  property_id  text    NOT NULL,
  date         date    NOT NULL,
  landing_page text    NOT NULL,
  sessions     integer,
  total_users  integer,
  new_users    integer,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, date, landing_page)
);

CREATE INDEX ga4_landing_pages_property_date_idx
  ON ga4_landing_pages(property_id, date DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────────
--
-- RLS enabled on every table. ZERO authenticated or anon policies.
-- Only service_role (sync process and server actions) can read or write.
-- PostgREST cannot access these tables from any browser session.
-- Server actions enforce getCurrentUser() → canAccessMarketing() →
-- hasMarketingPermission() before issuing any query.

ALTER TABLE gsc_daily            ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_queries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gsc_pages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ga4_daily            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ga4_traffic_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ga4_landing_pages    ENABLE ROW LEVEL SECURITY;
