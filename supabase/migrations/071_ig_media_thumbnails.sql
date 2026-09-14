-- Migration 071: add media_url and thumbnail_url to meta_ig_media
--
-- Meta Graph API returns:
--   media_url      — image URL for IMAGE / CAROUSEL_ALBUM cover
--   thumbnail_url  — video/reel poster frame
-- Both are nullable. These are ~60-day expiring CDN URLs hosted by Meta.

ALTER TABLE meta_ig_media
  ADD COLUMN IF NOT EXISTS media_url     text,
  ADD COLUMN IF NOT EXISTS thumbnail_url text;
