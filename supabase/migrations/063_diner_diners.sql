-- 063_diner_diners.sql
--
-- Mystery Diner — permanent identity/access records (reusable access model).
--
-- Management adds a diner once. They receive a single reusable personal link
-- they can use to start unlimited Mystery Dining visits until management
-- disables them.
--
-- Each visit still produces a fresh diner_invitations row (the "visit envelope")
-- so the existing form / autosave / submit / scoring / reporting pipeline is
-- preserved unchanged.
--
-- Changes:
--   1. New table: diner_diners
--   2. diner_invitations.diner_id  — nullable FK to diner_diners
--   3. diner_invitations.created_by_user_id — made nullable (system-created rows)

-- ===========================================================================
-- 1. diner_diners
-- ===========================================================================

CREATE TABLE diner_diners (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text        NOT NULL,
  email                text        NOT NULL,
  -- active   → access link is live
  -- disabled → access link is blocked; diner sees a disabled message
  status               text        NOT NULL DEFAULT 'active'
    CONSTRAINT diner_diners_status_check
    CHECK (status IN ('active', 'disabled')),
  -- SHA-256 hex of the raw permanent access token. Raw token is never stored.
  token_hash           text        NOT NULL UNIQUE,
  -- AES-256-GCM encrypted full access URL (same model as encrypted_invite_url).
  -- Required to support "Resend link" without re-generating the token.
  -- NULL if DINER_INVITE_SECRET was not configured at creation time.
  encrypted_access_url text,
  created_by_user_id   uuid        NOT NULL REFERENCES app_users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  disabled_at          timestamptz
);

CREATE INDEX diner_diners_status_idx ON diner_diners (status);
CREATE INDEX diner_diners_email_idx  ON diner_diners (email);

-- RLS: management roles may read; all writes via service_role
ALTER TABLE diner_diners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "diner_diners: management can read"
  ON diner_diners FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- ===========================================================================
-- 2. diner_invitations — add diner_id, relax created_by_user_id
-- ===========================================================================

-- Link visit envelopes back to the permanent diner identity.
-- NULL for legacy one-time invitations created before this migration.
ALTER TABLE diner_invitations
  ADD COLUMN diner_id uuid REFERENCES diner_diners(id) ON DELETE SET NULL;

CREATE INDEX diner_invitations_diner_id_idx ON diner_invitations (diner_id);

-- System-created visit envelopes (from /api/diner/start-visit) have no human
-- creator — the action is attributed to the diner identity itself.
ALTER TABLE diner_invitations
  ALTER COLUMN created_by_user_id DROP NOT NULL;
