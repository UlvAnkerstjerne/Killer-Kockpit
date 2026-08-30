-- Migration 010: Gmail integration (Phase B)
--
-- Gmail source provenance is mailbox/account-aware.
-- The same Gmail message ID can exist as provenance from different connected
-- KK user mailboxes without identity collision.
--
-- 1. sources.source_account_user_id
--    Identifies which KK user's connected Google mailbox produced a user-specific
--    source.  NULL = global source (calendar_event, drive_file, manual_entry, …).
--    Gmail source identity = (source_type, source_account_user_id, external_id).
--
-- 2. Unique constraint replacement
--    The blanket UNIQUE(source_type, external_id) is replaced with two partial
--    unique indexes:
--      • user-specific sources  — unique on (source_type, account_user, external_id)
--      • global sources         — unique on (source_type, external_id) WHERE account IS NULL
--    This preserves idempotent upsert semantics for both cases.
--
-- 3. entity_sources index
--    Efficient reverse lookup: which sources produced a given entity?
--
-- 4. google_oauth_tokens.google_account_email
--    Stores the Google Workspace email address of the connected account.
--    Used to build account-aware Gmail deep links (authuser=) and to display
--    which Google account is connected in Settings.

-- ── sources: drop blanket unique constraint ────────────────────────────────
ALTER TABLE sources
  DROP CONSTRAINT IF EXISTS sources_source_type_external_id_key;

-- ── sources: add per-account foreign key ──────────────────────────────────
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS source_account_user_id uuid
    REFERENCES app_users(id) ON DELETE SET NULL;

-- ── sources: partial unique index for user-specific sources ───────────────
-- Gmail messages from different connected mailboxes are distinct provenance.
CREATE UNIQUE INDEX IF NOT EXISTS sources_user_specific_unique
  ON sources (source_type, source_account_user_id, external_id)
  WHERE source_account_user_id IS NOT NULL;

-- ── sources: partial unique index for global (non-user) sources ───────────
-- Preserves prior uniqueness behaviour for calendar events, drive files, etc.
CREATE UNIQUE INDEX IF NOT EXISTS sources_global_unique
  ON sources (source_type, external_id)
  WHERE source_account_user_id IS NULL;

-- ── entity_sources: reverse-lookup index ──────────────────────────────────
CREATE INDEX IF NOT EXISTS entity_sources_entity_idx
  ON entity_sources (entity_type, entity_id);

-- ── google_oauth_tokens: connected account email ──────────────────────────
ALTER TABLE google_oauth_tokens
  ADD COLUMN IF NOT EXISTS google_account_email text;
