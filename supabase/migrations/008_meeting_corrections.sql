-- Migration 008: Meeting corrections / amendments
--
-- Published meetings are immutable. This table stores post-publication
-- corrections that appear beneath the original minutes without altering them.
-- All writes go through add_meeting_correction_and_audit (SECURITY DEFINER).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE meeting_corrections (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  body        text        NOT NULL,
  reason      text,
  author_id   uuid        REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meeting_corrections_meeting_idx
  ON meeting_corrections(meeting_id, created_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE meeting_corrections ENABLE ROW LEVEL SECURITY;

-- Management sees all corrections
CREATE POLICY "meeting_corrections: management can read"
  ON meeting_corrections FOR SELECT TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Members see corrections for meetings they own or attended
CREATE POLICY "meeting_corrections: member can read attended"
  ON meeting_corrections FOR SELECT TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND meeting_id IN (
      SELECT id FROM meetings
      WHERE owner_user_id = get_my_app_user_id()
         OR id IN (
           SELECT meeting_id FROM meeting_attendees
           WHERE user_id = get_my_app_user_id()
         )
    )
  );

-- No direct writes
CREATE POLICY "meeting_corrections: no direct insert"
  ON meeting_corrections FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "meeting_corrections: no direct update"
  ON meeting_corrections FOR UPDATE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- add_meeting_correction_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION add_meeting_correction_and_audit(
  p_meeting_id    uuid,
  p_body          text,
  p_reason        text,
  p_actor_user_id uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Verify meeting is published; corrections only apply to published minutes
  PERFORM 1 FROM meetings WHERE id = p_meeting_id AND status = 'published';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meeting % is not in published status', p_meeting_id;
  END IF;

  INSERT INTO meeting_corrections (meeting_id, body, reason, author_id)
  VALUES (p_meeting_id, trim(p_body), nullif(trim(p_reason), ''), p_actor_user_id)
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id,
    'human',
    'meeting.correction_added',
    'meeting',
    p_meeting_id,
    jsonb_build_object('correction_id', v_id, 'body', p_body, 'reason', p_reason)
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION add_meeting_correction_and_audit(uuid, text, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION add_meeting_correction_and_audit(uuid, text, text, uuid) TO service_role;
