-- 023_reopen_meeting.sql
--
-- Adds reopen_meeting_and_audit stored procedure.
--
-- Meeting cancellation already exists via cancel_meeting_and_audit (006_meetings.sql).
-- Reopening restores the meeting to 'scheduled' status, preserving all content.
--
-- Security model: same pattern as all lifecycle RPCs.
--   REVOKE EXECUTE from anon and authenticated (explicit, to cover Supabase auto-grants).
--   GRANT EXECUTE only to service_role.

CREATE OR REPLACE FUNCTION reopen_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid,
  p_before_status text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meetings
  SET status = 'scheduled'
  WHERE id = p_meeting_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.reopened', 'meeting', p_meeting_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'scheduled')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reopen_meeting_and_audit(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reopen_meeting_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION reopen_meeting_and_audit(uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION reopen_meeting_and_audit(uuid, uuid, text) TO service_role;
