-- Migration 007: Fix add_meeting_attendee ON CONFLICT clause
--
-- Bug: migration 006 created meeting_attendees_internal_uniq as a UNIQUE INDEX
-- (via CREATE UNIQUE INDEX), which only registers in pg_index, not pg_constraint.
-- The INSERT used `ON CONFLICT ON CONSTRAINT meeting_attendees_internal_uniq`
-- which requires a named entry in pg_constraint — causing a runtime error:
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Fix: replace the constraint-name form with the column+predicate form that works
-- with partial unique indexes: ON CONFLICT (col1, col2) WHERE predicate.

CREATE OR REPLACE FUNCTION add_meeting_attendee(
  p_meeting_id     uuid,
  p_user_id        uuid,
  p_external_name  text,
  p_external_email text,
  p_actor_user_id  uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO meeting_attendees (meeting_id, user_id, external_name, external_email)
  VALUES (p_meeting_id, p_user_id, p_external_name, p_external_email)
  ON CONFLICT (meeting_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
    VALUES (
      p_actor_user_id, 'human', 'meeting.attendee_added', 'meeting', p_meeting_id,
      jsonb_build_object(
        'user_id', p_user_id,
        'external_name', p_external_name
      )
    );
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION add_meeting_attendee(uuid, uuid, text, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION add_meeting_attendee(uuid, uuid, text, text, uuid) TO service_role;
