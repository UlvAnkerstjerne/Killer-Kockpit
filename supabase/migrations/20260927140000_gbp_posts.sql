-- ── gbp_posts ──────────────────────────────────────────────────────────────
--
-- Publish history for GBP local posts and location photos.
-- One row per publish action (which may fan out to multiple locations).
-- Per-location results are stored in the JSONB locations array.
--
-- This is operational history — not a full social scheduler.

CREATE TABLE gbp_posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_user_id uuid NOT NULL REFERENCES app_users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- post type: 'local_post' or 'photo'
  post_type         text NOT NULL CHECK (post_type IN ('local_post', 'photo')),

  -- caption / post text (null for photo-only)
  caption           text,

  -- image reference — storage path in gbp-media bucket
  image_storage_path text NOT NULL,

  -- public URL served to Google (signed or public)
  image_public_url   text NOT NULL,

  -- aggregate results
  locations_attempted int NOT NULL DEFAULT 0,
  locations_succeeded int NOT NULL DEFAULT 0,
  locations_failed    int NOT NULL DEFAULT 0,

  -- per-location results: [{location_id, location_name, status, error?, google_resource_name?}]
  location_results   jsonb NOT NULL DEFAULT '[]'::jsonb
);

ALTER TABLE gbp_posts ENABLE ROW LEVEL SECURITY;

-- No permissive policies — service_role only (same pattern as gbp_locations).
GRANT ALL ON gbp_posts TO service_role;

CREATE INDEX idx_gbp_posts_publisher ON gbp_posts(publisher_user_id);
CREATE INDEX idx_gbp_posts_created   ON gbp_posts(created_at DESC);
