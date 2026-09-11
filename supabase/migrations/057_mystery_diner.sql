-- 057_mystery_diner.sql
--
-- Mystery Diner — public invitation + response foundation.
--
-- External mystery diners have no Kockpit account. They receive a secure
-- link, open a mobile-first form, autosave responses, and submit once.
-- Completed submissions are immutable.
--
-- Tables:
--   diner_invitations  — one per invite; holds token_hash + lifecycle state
--   diner_submissions  — one per invitation; created on first link access
--   diner_responses    — per-checkpoint answers; locked on submit
--
-- Access model:
--   • No direct anon or authenticated access to any diner table.
--   • Management users create invitations via server actions using service_role
--     after explicit role check in application code.
--   • Public link handler (route.ts) reads/writes via service_role after
--     validating the raw token against token_hash.
--   • Session cookies (HMAC-SHA256, HttpOnly) are issued after token validation;
--     all subsequent autosave requests authenticate via cookie only.
--   • submit_diner_submission() is a SECURITY DEFINER RPC callable by service_role.
--
-- Immutability:
--   • diner_submissions: once status = 'submitted', no further updates.
--   • diner_responses: INSERT/UPDATE blocked when submission is submitted.
--   • diner_responses: DELETE always blocked.
--
-- Future work:
--   • diner_checkpoints table (FK for diner_responses.checkpoint_id added then).
--   • Resend invite email — token_hash already stored; raw token revealed once at creation.
--   • Score computation in submit_diner_submission() when checkpoints exist.

-- ===========================================================================
-- 1. diner_invitations
-- ===========================================================================

CREATE TABLE diner_invitations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex of the raw URL token. Raw token is never stored.
  token_hash          text        NOT NULL UNIQUE,
  -- Optional canonical location (nullable — some invites may be location-agnostic)
  location_id         uuid        REFERENCES locations(id) ON DELETE SET NULL,
  diner_name          text        NOT NULL,
  -- Nullable — future Resend invite email; not required for link-only flow
  diner_email         text,
  created_by_user_id  uuid        NOT NULL REFERENCES app_users(id),
  expires_at          timestamptz NOT NULL,
  -- pending  → created, never accessed
  -- active   → first link access (submission created)
  -- submitted → submission submitted
  -- expired  → expired without submission (set by server at access-time check only)
  status              text        NOT NULL DEFAULT 'pending'
    CONSTRAINT diner_invitations_status_check
    CHECK (status IN ('pending', 'active', 'submitted', 'expired')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX diner_invitations_status_idx ON diner_invitations (status);
CREATE INDEX diner_invitations_created_by_idx ON diner_invitations (created_by_user_id);

-- ===========================================================================
-- 2. diner_submissions
-- ===========================================================================

-- One submission per invitation. Created on first link access (status = active).
-- UNIQUE on invitation_id enforces the one-submission-per-invite rule at the
-- DB layer; concurrent first-access attempts produce a 23505 which the handler
-- resolves by fetching the winning row.

CREATE TABLE diner_submissions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid        NOT NULL UNIQUE REFERENCES diner_invitations(id) ON DELETE CASCADE,
  status        text        NOT NULL DEFAULT 'in_progress'
    CONSTRAINT diner_submissions_status_check
    CHECK (status IN ('in_progress', 'submitted')),
  -- Recorded when the submission row is created (first link access)
  started_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX diner_submissions_invitation_idx ON diner_submissions (invitation_id);

-- Immutability: once submitted, no further updates.
CREATE OR REPLACE FUNCTION _check_diner_submission_mutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION 'Submitted Mystery Diner submissions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER diner_submission_immutability
  BEFORE UPDATE ON diner_submissions
  FOR EACH ROW EXECUTE FUNCTION _check_diner_submission_mutable();

-- ===========================================================================
-- 3. diner_responses
-- ===========================================================================

-- checkpoint_id is uuid without a FK until diner_checkpoints is added in a
-- future migration. The UNIQUE constraint already enforces one response per
-- (submission, checkpoint) combination.

CREATE TABLE diner_responses (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid        NOT NULL REFERENCES diner_submissions(id) ON DELETE CASCADE,
  -- Will reference diner_checkpoints.id once that table is created (migration 058+)
  checkpoint_id uuid        NOT NULL,
  result        text
    CONSTRAINT diner_responses_result_check
    CHECK (result IN ('pass', 'fail', 'na')),
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, checkpoint_id)
);

CREATE INDEX diner_responses_submission_idx ON diner_responses (submission_id);

-- Block INSERT/UPDATE when the submission is already submitted.
CREATE OR REPLACE FUNCTION _check_diner_response_open()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM diner_submissions
    WHERE id = NEW.submission_id AND status = 'submitted'
  ) THEN
    RAISE EXCEPTION 'Cannot modify responses for a submitted Mystery Diner audit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER diner_response_open_check
  BEFORE INSERT OR UPDATE ON diner_responses
  FOR EACH ROW EXECUTE FUNCTION _check_diner_response_open();

-- DELETE always denied — responses are append-only until submission.
CREATE OR REPLACE FUNCTION _deny_diner_response_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Mystery Diner responses cannot be deleted';
END;
$$;

CREATE TRIGGER diner_response_no_delete
  BEFORE DELETE ON diner_responses
  FOR EACH ROW EXECUTE FUNCTION _deny_diner_response_delete();

-- ===========================================================================
-- 4. RLS — no direct access; all writes go through service_role
-- ===========================================================================

ALTER TABLE diner_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE diner_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE diner_responses   ENABLE ROW LEVEL SECURITY;

-- Management users (SUPER_ADMIN, UM) may read all invitations they created
-- or any invitation (full list for management dashboard — no row-level filter
-- beyond the authenticated check; management can see all company invitations).
CREATE POLICY "diner_invitations: management can read"
  ON diner_invitations FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- No other authenticated or anon policies — all writes via service_role.
-- diner_submissions and diner_responses have no authenticated policies:
-- management views use service_role queries in server actions.

-- ===========================================================================
-- 5. submit_diner_submission — SECURITY DEFINER RPC
-- ===========================================================================
--
-- Marks a submission as submitted. Callable by service_role only.
-- Accepts both submission_id and invitation_id to verify the session is
-- correctly scoped (defence-in-depth against cookie/ID mismatch bugs).
--
-- Currently performs no score computation — placeholder for when
-- diner_checkpoints and scoring logic are added (migration 058+).
--
-- Returns: 'submitted' on success, raises EXCEPTION on invalid state.

CREATE OR REPLACE FUNCTION submit_diner_submission(
  p_submission_id  uuid,
  p_invitation_id  uuid
)
RETURNS text
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  -- Lock the row to prevent concurrent submits
  SELECT status INTO v_status
  FROM diner_submissions
  WHERE id = p_submission_id AND invitation_id = p_invitation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission not found or invitation mismatch';
  END IF;

  IF v_status = 'submitted' THEN
    RAISE EXCEPTION 'Already submitted';
  END IF;

  -- Mark submission submitted
  UPDATE diner_submissions
  SET status       = 'submitted',
      submitted_at = now()
  WHERE id = p_submission_id;

  -- Sync invitation status
  UPDATE diner_invitations
  SET status     = 'submitted',
      updated_at = now()
  WHERE id = p_invitation_id;

  RETURN 'submitted';
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) TO service_role;
