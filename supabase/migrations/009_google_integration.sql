-- Migration 009: Google Calendar integration (Phase A)
--
-- 1. google_oauth_tokens
--    Stores AES-256-GCM encrypted OAuth credentials per user.
--    RLS is ENABLED but NO permissive policies exist for the authenticated
--    or anon roles.  Only service_role (which bypasses RLS entirely) may
--    read or write this table.  This makes the table invisible to PostgREST
--    and to any user-session Supabase client.
--    Tokens are encrypted at the application layer before storage;
--    the encryption key never enters the database.
--
-- 2. calendar sync status columns on meetings
--    Surface sync failures without blocking meeting operations.
--    calendar_sync_status  — latest sync state (synced / failed / pending)
--    calendar_sync_error   — human-readable error from last failed attempt
--    calendar_synced_at    — timestamp of last successful sync
--    calendar_event_url    — Google Calendar htmlLink for direct access

-- ---------------------------------------------------------------------------
-- google_oauth_tokens
-- ---------------------------------------------------------------------------

CREATE TABLE google_oauth_tokens (
  user_id                  uuid        PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  encrypted_access_token   text        NOT NULL,
  encrypted_refresh_token  text        NOT NULL,
  expires_at               timestamptz NOT NULL,
  scopes                   text[]      NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER google_oauth_tokens_updated_at
  BEFORE UPDATE ON google_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS.  No permissive policies are created for authenticated or anon
-- roles — only service_role (which bypasses RLS) can access this table.
ALTER TABLE google_oauth_tokens ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Calendar sync status columns on meetings
-- ---------------------------------------------------------------------------
--
-- calendar_synced_by_user_id
--   Tracks whose Google OAuth credential was used to create/own the Calendar
--   event.  Automatic resyncs (scheduling changes, attendee changes,
--   cancellation) use this stored credential rather than whichever user
--   happens to trigger the mutation.  Any authorised editor can take over
--   by clicking "Send to Google Calendar"; the patch-before-insert strategy
--   updates the existing event rather than creating a duplicate.
--   SET NULL on user deletion so the meeting row is not lost.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS calendar_sync_status      text
    CHECK (calendar_sync_status IN ('synced', 'failed', 'pending')),
  ADD COLUMN IF NOT EXISTS calendar_sync_error       text,
  ADD COLUMN IF NOT EXISTS calendar_synced_at        timestamptz,
  ADD COLUMN IF NOT EXISTS calendar_event_url        text,
  ADD COLUMN IF NOT EXISTS calendar_synced_by_user_id uuid
    REFERENCES app_users(id) ON DELETE SET NULL;
