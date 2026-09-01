-- Killer Kockpit — Marketing M3: Meta Data Ingestion
--
-- Tables:
--   meta_ad_accounts      — discovered Meta ad accounts (currency source of truth)
--   meta_ad_campaigns     — campaign structure
--   meta_ad_sets          — ad set structure
--   meta_ads              — ad structure
--   meta_ad_insights      — daily ad-level performance (fetched at ad level)
--   meta_campaign_insights— daily campaign-level performance (fetched at campaign level)
--   meta_ig_media         — Instagram media posts
--   meta_ig_account_daily — daily Instagram account-level metrics
--   meta_fb_page_insights — daily Facebook Page metrics (v26 field names)
--   meta_fb_posts         — Facebook Page organic posts
--   meta_fb_post_insights — per-post organic performance
--
-- Partial unique index for institutional integration_sync_state rows:
--   Deferred from migration 017. Not added by 018_gbp because GBP uses
--   per-user tokens (user_id IS NOT NULL). Meta integration is institutional
--   (user_id IS NULL), requiring this index to prevent duplicate sync rows.
--
-- RLS: enabled on all tables; ZERO authenticated/anon policies.
--   All reads/writes via service_role (sync process and server actions).
--   Server actions enforce marketing_access + paid_manage before any query.
--   PostgREST cannot access these tables from a browser session.
--
-- Money fields: numeric(19,6) — exact decimal as returned by Meta API
--   (no ×100 conversion; account currency is stored in meta_ad_accounts).
--   PostgreSQL numeric avoids float drift for any currency decimal convention.

-- ── Institutional sync state deduplication ────────────────────────────────────
--
-- The existing UNIQUE (integration, user_id) constraint treats NULL as distinct
-- (SQL standard), so multiple rows with user_id IS NULL can co-exist.
-- This partial index ensures at most one institutional sync row per integration key.

CREATE UNIQUE INDEX integration_sync_state_institutional_unique
  ON integration_sync_state(integration)
  WHERE user_id IS NULL;

-- ── meta_ad_accounts ──────────────────────────────────────────────────────────
--
-- Populated by asset discovery (discoverMetaAssets). Stores the currency so
-- all monetary insight values can be correctly interpreted by the UI.
--
-- currency: ISO 4217 code as returned by Meta (e.g. 'DKK', 'EUR', 'GBP').
-- All numeric money columns in meta_ad_insights / meta_campaign_insights are
-- in this currency as exact decimals.

CREATE TABLE meta_ad_accounts (
  id              text        PRIMARY KEY,   -- act_{numeric_id}
  name            text        NOT NULL,
  currency        text        NOT NULL,      -- ISO 4217 from Meta API; never assumed
  account_status  integer,                   -- 1=active, 2=disabled, etc.
  synced_at       timestamptz NOT NULL DEFAULT now()
);

-- ── meta_ad_campaigns ─────────────────────────────────────────────────────────

CREATE TABLE meta_ad_campaigns (
  id              text        PRIMARY KEY,   -- numeric campaign ID string
  ad_account_id   text        NOT NULL REFERENCES meta_ad_accounts(id),
  name            text        NOT NULL,
  status          text        NOT NULL,      -- ACTIVE | PAUSED | DELETED | ARCHIVED
  objective       text,
  daily_budget    numeric(19,6),             -- in account currency
  lifetime_budget numeric(19,6),             -- in account currency
  created_at_meta timestamptz,
  synced_at       timestamptz NOT NULL DEFAULT now()
);

-- ── meta_ad_sets ──────────────────────────────────────────────────────────────

CREATE TABLE meta_ad_sets (
  id            text        PRIMARY KEY,
  campaign_id   text        NOT NULL REFERENCES meta_ad_campaigns(id),
  name          text        NOT NULL,
  status        text        NOT NULL,
  daily_budget  numeric(19,6),
  synced_at     timestamptz NOT NULL DEFAULT now()
);

-- ── meta_ads ──────────────────────────────────────────────────────────────────

CREATE TABLE meta_ads (
  id          text        PRIMARY KEY,
  ad_set_id   text        NOT NULL REFERENCES meta_ad_sets(id),
  name        text        NOT NULL,
  status      text        NOT NULL,
  synced_at   timestamptz NOT NULL DEFAULT now()
);

-- ── meta_ad_insights ──────────────────────────────────────────────────────────
--
-- Daily ad-level performance fetched directly at ad level from Meta.
-- reach at this level = unique people who saw this specific ad.
-- Do NOT sum reach across ads to derive campaign reach — it is non-additive.
-- Campaign reach comes from meta_campaign_insights (fetched at campaign level).
--
-- spend/cpm/cpc: exact decimal in account currency (meta_ad_accounts.currency).
-- ctr: fraction (e.g. 0.0231 = 2.31%). Stored as returned by Meta.
--
-- actions_json: raw [{action_type, value}] array from Meta — preserves original
--   action type strings so AI analysis does not mislabel outcomes.
-- action_values_json: raw [{action_type, value}] for purchase/conversion values.
-- cost_per_action_json: raw [{action_type, value}] for cost-per-action metrics.

CREATE TABLE meta_ad_insights (
  ad_id                text          NOT NULL REFERENCES meta_ads(id),
  date_start           date          NOT NULL,
  -- Universal structured metrics
  impressions          bigint,
  reach                bigint,
  clicks               bigint,
  inline_link_clicks   bigint,
  spend                numeric(19,6),
  cpm                  numeric(19,6),
  cpc                  numeric(19,6),
  ctr                  numeric(8,6),
  -- Objective-specific: raw Meta arrays, action_type strings preserved
  actions_json         jsonb,
  cost_per_action_json jsonb,
  action_values_json   jsonb,
  PRIMARY KEY (ad_id, date_start)
);

-- ── meta_campaign_insights ────────────────────────────────────────────────────
--
-- Daily campaign-level performance fetched directly at campaign level from Meta.
-- reach and frequency here are CORRECT campaign-level values (not summed from ads).
-- frequency = impressions / reach — only meaningful at campaign level.
-- All monetary values in meta_ad_accounts.currency exact decimal.

CREATE TABLE meta_campaign_insights (
  campaign_id          text          NOT NULL REFERENCES meta_ad_campaigns(id),
  date_start           date          NOT NULL,
  impressions          bigint,
  reach                bigint,
  clicks               bigint,
  inline_link_clicks   bigint,
  spend                numeric(19,6),
  cpm                  numeric(19,6),
  cpc                  numeric(19,6),
  ctr                  numeric(8,6),
  frequency            numeric(8,4),          -- campaign-level only
  actions_json         jsonb,
  cost_per_action_json jsonb,
  action_values_json   jsonb,
  PRIMARY KEY (campaign_id, date_start)
);

CREATE INDEX meta_campaign_insights_date_idx
  ON meta_campaign_insights(date_start DESC);

-- ── meta_ig_media ─────────────────────────────────────────────────────────────
--
-- Instagram media (photos, videos, reels). One row per media item.
-- Insights columns use current v26 metric names.
-- `plays` applies to VIDEO / REEL types only; NULL for IMAGE.
-- `impressions` omitted — deprecated or unavailable in v26 for some types.
-- `other_metrics_json` captures any additional API fields not in columns.

CREATE TABLE meta_ig_media (
  id              text        PRIMARY KEY,   -- IG media ID
  ig_account_id   text        NOT NULL,
  media_type      text        NOT NULL,      -- IMAGE | VIDEO | CAROUSEL_ALBUM | REEL
  caption         text,
  permalink       text,
  published_at    timestamptz,
  -- Insights (current v26 metrics; populated on deep organic sync)
  reach           integer,
  plays           integer,                   -- video/reel only; NULL for images
  saved           integer,
  likes           integer,
  comments_count  integer,
  shares          integer,
  total_interactions integer,
  other_metrics_json jsonb,                  -- captures any metric not in columns above
  synced_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meta_ig_media_account_published_idx
  ON meta_ig_media(ig_account_id, published_at DESC);

-- ── meta_ig_account_daily ─────────────────────────────────────────────────────
--
-- Daily account-level Instagram metrics. One row per (ig_account_id, date).
-- Metrics from GET /{ig-user-id}/insights with period=day.
-- followers_count from GET /{ig-user-id}?fields=followers_count (point-in-time).
-- other_metrics_json for any additional metrics returned beyond structured columns.

CREATE TABLE meta_ig_account_daily (
  ig_account_id   text        NOT NULL,
  date            date        NOT NULL,
  reach           integer,                   -- unique accounts that saw any content
  accounts_engaged integer,                  -- accounts that engaged (Dec 2025 metric)
  profile_views   integer,                   -- unique accounts that viewed the profile
  followers_count integer,                   -- from account object, point-in-time
  other_metrics_json jsonb,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ig_account_id, date)
);

-- ── meta_fb_page_insights ─────────────────────────────────────────────────────
--
-- Daily Facebook Page metrics. One row per (page_id, date).
--
-- v26 field names (deprecated fields NOT included):
--   views    — replaces deprecated `impressions` (deprecated Nov 2025 / Jun 2026)
--   reach    — unchanged
--   engaged_users — unchanged
--   page_fans/page_fan_adds — DEPRECATED; use fan_count from Page object instead
--
-- fan_count: fetched from GET /{page-id}?fields=fan_count (Page object, not insights).
--   Stored as a point-in-time snapshot at sync time.

CREATE TABLE meta_fb_page_insights (
  page_id       text    NOT NULL,
  date          date    NOT NULL,
  views         bigint,                      -- replaces deprecated page_impressions
  reach         bigint,
  engaged_users bigint,
  fan_count     bigint,                      -- point-in-time from Page object
  other_metrics_json jsonb,
  PRIMARY KEY (page_id, date)
);

CREATE INDEX meta_fb_page_insights_date_idx
  ON meta_fb_page_insights(date DESC);

-- ── meta_fb_posts ─────────────────────────────────────────────────────────────
--
-- Facebook Page organic posts. Identity and content.
-- Insights stored separately in meta_fb_post_insights.

CREATE TABLE meta_fb_posts (
  id            text        PRIMARY KEY,     -- FB post ID
  page_id       text        NOT NULL,
  post_type     text        NOT NULL,        -- link | status | photo | video | reel | story
  message       text,                        -- caption/text content
  permalink     text,
  published_at  timestamptz NOT NULL,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meta_fb_posts_page_published_idx
  ON meta_fb_posts(page_id, published_at DESC);

-- ── meta_fb_post_insights ─────────────────────────────────────────────────────
--
-- Per-post organic performance. One row per post — upserted on each deep sync.
-- Uses v26 metric names. `impressions` deprecated; use `views`.
-- other_metrics_json for type-specific or future metrics.

CREATE TABLE meta_fb_post_insights (
  post_id         text        PRIMARY KEY REFERENCES meta_fb_posts(id),
  views           bigint,                    -- replaces deprecated post_impressions
  reach           bigint,
  engaged_users   bigint,
  reactions_total bigint,
  comments        bigint,
  shares          bigint,
  clicks          bigint,
  other_metrics_json jsonb,
  synced_at       timestamptz NOT NULL DEFAULT now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
--
-- RLS enabled on every table. ZERO authenticated or anon policies.
-- Only service_role (sync process and server actions) can read or write.
-- PostgREST cannot access these tables from any browser session.
-- Server actions enforce getCurrentUser() → canAccessMarketing() →
-- hasMarketingPermission(..., 'paid_manage') before issuing any query.

ALTER TABLE meta_ad_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_campaigns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_sets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ads               ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_insights       ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_campaign_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ig_media          ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ig_account_daily  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_fb_page_insights  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_fb_posts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_fb_post_insights  ENABLE ROW LEVEL SECURITY;
