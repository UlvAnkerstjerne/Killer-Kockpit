-- Killer Kockpit — Meeting location (venue / meeting place)
--
-- Adds a free-text location field to meetings (e.g. "Killer Kebab office",
-- "Borgergade", "Google Meet", "Restaurant X").  This is scheduling metadata,
-- not a relationship to the canonical Locations entity.
--
-- Changes:
--   1. meetings.location text null
--   2. create_meeting_and_audit — drop 8-param overload, recreate with
--      p_location text DEFAULT NULL (9 params, backward-compatible via DEFAULT)
--   3. update_meeting_and_audit — add location CASE (same JSONB-patch signature)

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location text;

-- ---------------------------------------------------------------------------
-- 2. create_meeting_and_audit (replace 8-param with 9-param + DEFAULT)
--
-- DROP first to remove the old overload; the new function has a different
-- arity so CREATE OR REPLACE alone would create a second overload.
-- The DEFAULT NULL on p_location keeps existing callers working.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid);

CREATE OR REPLACE FUNCTION create_meeting_and_audit(
  p_title              text,
  p_owner_user_id      uuid,
  p_project_id         uuid,
  p_scheduled_start    timestamptz,
  p_scheduled_end      timestamptz,
  p_context            text,
  p_created_by_user_id uuid,
  p_actor_user_id      uuid,
  p_location           text DEFAULT NULL
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO meetings (
    title, owner_user_id, project_id, scheduled_start, scheduled_end,
    context, created_by_user_id, location, status
  ) VALUES (
    p_title, p_owner_user_id, p_project_id, p_scheduled_start, p_scheduled_end,
    p_context, p_created_by_user_id, p_location, 'scheduled'
  )
  RETURNING id INTO v_id;

  -- Auto-add the creator as an attendee
  INSERT INTO meeting_attendees (meeting_id, user_id)
  VALUES (v_id, p_created_by_user_id)
  ON CONFLICT DO NOTHING;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.created', 'meeting', v_id,
    jsonb_build_object('title', p_title, 'status', 'scheduled')
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. update_meeting_and_audit — add location CASE
--    Same (uuid, uuid, jsonb, jsonb) signature — true OR REPLACE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid,
  p_patch         jsonb,
  p_before        jsonb
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_field text;
BEGIN
  UPDATE meetings SET
    title           = CASE WHEN p_patch ? 'title'            THEN  p_patch->>'title'                             ELSE title            END,
    context         = CASE WHEN p_patch ? 'context'          THEN  p_patch->>'context'                           ELSE context          END,
    working_notes   = CASE WHEN p_patch ? 'working_notes'    THEN  p_patch->>'working_notes'                     ELSE working_notes    END,
    owner_user_id   = CASE WHEN p_patch ? 'owner_user_id'    THEN (p_patch->>'owner_user_id')::uuid               ELSE owner_user_id    END,
    project_id      = CASE WHEN p_patch ? 'project_id'       THEN (p_patch->>'project_id')::uuid                 ELSE project_id       END,
    scheduled_start = CASE WHEN p_patch ? 'scheduled_start'  THEN (p_patch->>'scheduled_start')::timestamptz     ELSE scheduled_start  END,
    scheduled_end   = CASE WHEN p_patch ? 'scheduled_end'    THEN (p_patch->>'scheduled_end')::timestamptz       ELSE scheduled_end    END,
    location        = CASE WHEN p_patch ? 'location'         THEN  p_patch->>'location'                          ELSE location         END
  WHERE id = p_meeting_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'meeting.' || v_field || '.changed',
      'meeting', p_meeting_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;
