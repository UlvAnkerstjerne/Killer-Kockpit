-- Killer Kockpit — Marketing M2: Google Business Profile integration
--
-- Tables:
--   gbp_locations        — maps GBP location IDs to Killer Kebab stores
--   gbp_reviews          — imported Google reviews (idempotent upserts)
--   gbp_review_replies   — Kockpit-managed draft/approval/publish lifecycle
--   gbp_location_metrics — daily performance snapshots per location
--
-- Identifier conventions:
--   google_account_id  — bare numeric ID (e.g. "123456789")
--   google_location_id — bare numeric ID (e.g. "987654321")
--   Path construction is handled exclusively in lib/google/gbp-client.ts:
--     Account Mgmt API:  accounts/{google_account_id}
--     Business Info API: locations/{google_location_id}
--     Reviews v4 API:    accounts/{google_account_id}/locations/{google_location_id}/reviews/...
--   gbp_reviews.google_review_id stores the full compound v4 resource name
--   (e.g. "accounts/123/locations/456/reviews/AbCd...") returned by the API.
--   This is the stable unique identifier and the exact path prefix for the reply API.
--
-- Security:
--   RLS enabled on all tables. NO authenticated or anon policies — service_role only.
--   All reads/writes go through server actions (lib/actions/marketing/gbp-reviews.ts)
--   and the sync orchestrator (lib/gbp/sync.ts) using createServiceClient().
--   Server actions enforce: getCurrentUser() -> canAccessMarketing() -> hasMarketingPermission()
--   before executing any query. Follows the same pattern as google_oauth_tokens.
--
-- Sync state:
--   Per-location sync state uses the existing integration_sync_state table with
--   composite integration keys:
--     'gbp_reviews:{google_account_id}:{google_location_id}'
--     'gbp_metrics:{google_account_id}:{google_location_id}'
--   user_id = the SUPER_ADMIN whose token is used for sync.
--
-- Historical backfill vs. active-window behaviour:
--   gbp_locations.activation_date controls which unanswered historical reviews
--   receive AI drafts and Needs Review items. Reviews created before
--   (activation_date - 7 days) are imported for history only — no
--   gbp_review_replies row is created for them.

-- ── gbp_locations ─────────────────────────────────────────────────────────────

CREATE TABLE gbp_locations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Bare numeric IDs — path construction is in gbp-client.ts.
  google_account_id    text        NOT NULL,
  google_location_id   text        NOT NULL,
  UNIQUE (google_account_id, google_location_id),
  -- Killer Kebab store identity. This is the first canonical store entity in
  -- Kockpit. A general-purpose stores table can reference this later if needed.
  store_name           text        NOT NULL,   -- "Killer Kebab Copenhagen"
  store_short_name     text        NOT NULL,   -- "CPH"
  address_summary      text,                   -- city/area for display
  -- Activation date for the backfill cutoff.
  -- Set to CURRENT_DATE when the location row is first created.
  -- Reviews with review_created_at < (activation_date - 7 days) are imported
  -- for history only and do NOT generate drafts or Needs Review items.
  activation_date      date        NOT NULL DEFAULT CURRENT_DATE,
  active               boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER gbp_locations_updated_at
  BEFORE UPDATE ON gbp_locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── gbp_reviews ───────────────────────────────────────────────────────────────
--
-- google_review_id: full compound v4 resource name as returned by the API,
--   e.g. "accounts/123456789/locations/987654321/reviews/AbCdEfGh..."
--   Used directly as the path prefix for the reply PUT endpoint.
--
-- existing_reply_*: Google's currently published reply (if any).
--   Updated on every sync. A non-null existing_reply_text means the review
--   has already been answered on Google (by Kockpit or externally).
--   No gbp_review_replies row is created solely to represent an externally
--   existing reply — "already handled" is derived from this field.

CREATE TABLE gbp_reviews (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_review_id          text        NOT NULL UNIQUE,
  location_id               uuid        NOT NULL REFERENCES gbp_locations(id),
  reviewer_name             text,
  reviewer_photo_url        text,
  star_rating               integer     NOT NULL CHECK (star_rating BETWEEN 1 AND 5),
  review_text               text,                    -- NULL for rating-only reviews
  review_created_at         timestamptz NOT NULL,
  review_updated_at         timestamptz NOT NULL,
  -- Google's existing published reply (from GBP; may be our own after sync).
  existing_reply_text       text,
  existing_reply_updated_at timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  synced_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gbp_reviews_location_created_idx
  ON gbp_reviews(location_id, review_created_at DESC);

CREATE INDEX gbp_reviews_no_reply_idx
  ON gbp_reviews(location_id, review_created_at DESC)
  WHERE existing_reply_text IS NULL;

-- ── gbp_review_replies ────────────────────────────────────────────────────────
--
-- One row per review — created only for reviews that Kockpit is managing.
-- NOT created for reviews with existing_reply_text already set at import time.
-- NOT created for historical unanswered reviews outside the activation window.
--
-- Status lifecycle:
--   new                → review imported, AI draft pending
--   awaiting_review    → AI draft stored, item visible in Needs Review
--   approved           → human approved; awaiting publish
--   rejected           → human rejected; can be addressed manually
--   published          → successfully published to Google
--   publish_failed     → publish attempted, Google returned an error; retry available
--   externally_published → a reply appeared on Google outside of Kockpit
--                          (detected by sync when existing_reply_text is set for
--                          a review that had a pending Kockpit reply)
--
-- approved_text: the final reply text as confirmed by the approver.
--   May differ from draft_text if the approver edited before approving.
--   This is the text published to Google.

CREATE TABLE gbp_review_replies (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id             uuid        NOT NULL UNIQUE REFERENCES gbp_reviews(id) ON DELETE CASCADE,
  -- AI draft
  draft_text            text,
  draft_generated_at    timestamptz,
  draft_model           text,            -- e.g. "claude-sonnet-4-6"
  draft_prompt_version  text,            -- e.g. "v1"
  -- Approval lifecycle
  status                text        NOT NULL DEFAULT 'new'
    CHECK (status IN (
      'new',
      'awaiting_review',
      'approved',
      'rejected',
      'published',
      'publish_failed',
      'externally_published'
    )),
  approved_text         text,
  approved_by_user_id   uuid        REFERENCES app_users(id) ON DELETE SET NULL,
  approved_at           timestamptz,
  rejection_note        text,
  rejected_by_user_id   uuid        REFERENCES app_users(id) ON DELETE SET NULL,
  rejected_at           timestamptz,
  -- Publish state
  published_at          timestamptz,
  publish_error         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER gbp_review_replies_updated_at
  BEFORE UPDATE ON gbp_review_replies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX gbp_review_replies_status_idx
  ON gbp_review_replies(status)
  WHERE status IN ('awaiting_review', 'approved', 'publish_failed');

-- ── gbp_location_metrics ──────────────────────────────────────────────────────
--
-- Daily performance snapshots per location from the Business Profile Performance API.
-- NULL = metric not returned by Google for that day.
-- total_impressions is computed at sync time (sum of four channel breakdowns).
-- Review counts are derived from gbp_reviews.review_created_at in queries.

CREATE TABLE gbp_location_metrics (
  location_id                  uuid    NOT NULL REFERENCES gbp_locations(id),
  date                         date    NOT NULL,
  impressions_desktop_maps     integer,
  impressions_desktop_search   integer,
  impressions_mobile_maps      integer,
  impressions_mobile_search    integer,
  total_impressions            integer,  -- computed at sync: sum of four above
  website_clicks               integer,
  call_clicks                  integer,
  direction_requests           integer,
  synced_at                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, date)
);

CREATE INDEX gbp_location_metrics_date_idx
  ON gbp_location_metrics(date DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
--
-- No authenticated or anon policies — service_role only.
-- Mirrors the pattern used for google_oauth_tokens.

ALTER TABLE gbp_locations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE gbp_reviews           ENABLE ROW LEVEL SECURITY;
ALTER TABLE gbp_review_replies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE gbp_location_metrics  ENABLE ROW LEVEL SECURITY;
