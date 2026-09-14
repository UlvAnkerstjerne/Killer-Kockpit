-- 070: Add meeting_id provenance to create_task_and_audit,
--      create_waiting_on_and_audit, and create_decision_and_audit.
--
-- All three target tables already have a meeting_id FK column.
-- This migration drops the old function signatures and replaces them
-- with new ones that accept p_meeting_id uuid DEFAULT NULL.
-- Callers that omit p_meeting_id continue to work unchanged.

-- ─── create_task_and_audit ────────────────────────────────────────────────────
-- Drop the 9-param overload introduced in 003/044, replace with 10-param.

DROP FUNCTION IF EXISTS create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid);

CREATE FUNCTION create_task_and_audit(
  p_title              text,
  p_description        text,
  p_owner_user_id      uuid,
  p_project_id         uuid,
  p_status             text,
  p_priority           smallint,
  p_due_at             timestamptz,
  p_created_by_user_id uuid,
  p_actor_user_id      uuid,
  p_meeting_id         uuid DEFAULT NULL
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO tasks (
    title, description, owner_user_id, project_id,
    status, priority, due_at, created_by_user_id, meeting_id
  ) VALUES (
    p_title, p_description, p_owner_user_id, p_project_id,
    p_status::task_status, p_priority, p_due_at, p_created_by_user_id, p_meeting_id
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.created', 'task', v_id,
    jsonb_build_object(
      'title',         p_title,
      'status',        p_status,
      'owner_user_id', p_owner_user_id,
      'priority',      p_priority
    )
  );

  -- Delegated task: notify the assignee.
  -- Self-assigned (actor = owner): no notification.
  IF p_owner_user_id IS NOT NULL AND p_owner_user_id != p_actor_user_id THEN
    INSERT INTO notifications (type, entity_type, entity_id, recipient_user_id, actor_user_id)
    VALUES ('task.assigned', 'task', v_id, p_owner_user_id, p_actor_user_id);
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid, uuid) TO service_role;


-- ─── create_waiting_on_and_audit ──────────────────────────────────────────────
-- Drop the 9-param overload introduced in 024, replace with 10-param.

DROP FUNCTION IF EXISTS create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint);

CREATE FUNCTION create_waiting_on_and_audit(
  p_title                  text,
  p_owner_user_id          uuid,
  p_waiting_for_user_id    uuid,
  p_waiting_for_name       text,
  p_project_id             uuid,
  p_due_at                 timestamptz,
  p_notes                  text,
  p_actor_user_id          uuid,
  p_priority               smallint DEFAULT 2,
  p_meeting_id             uuid     DEFAULT NULL
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO waiting_ons (
    title, owner_user_id, waiting_for_user_id,
    waiting_for_name, project_id, due_at, notes, status, priority, meeting_id
  ) VALUES (
    p_title, p_owner_user_id, p_waiting_for_user_id,
    p_waiting_for_name, p_project_id, p_due_at, p_notes, 'open', p_priority, p_meeting_id
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'waiting_on.created', 'waiting_on', v_id,
    jsonb_build_object('title', p_title, 'status', 'open', 'priority', p_priority)
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint, uuid) TO service_role;


-- ─── create_decision_and_audit ────────────────────────────────────────────────
-- Drop the 9-param overload introduced in 004, replace with 10-param.

DROP FUNCTION IF EXISTS create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid);

CREATE FUNCTION create_decision_and_audit(
  p_title                  text,
  p_decision_text          text,
  p_rationale              text,
  p_owner_user_id          uuid,
  p_project_id             uuid,
  p_decided_at             timestamptz,
  p_status                 decision_status,
  p_supersedes_decision_id uuid,
  p_actor_user_id          uuid,
  p_meeting_id             uuid DEFAULT NULL
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO decisions (
    title, decision_text, rationale, owner_user_id,
    project_id, decided_at, status, supersedes_decision_id, meeting_id
  ) VALUES (
    p_title, p_decision_text, p_rationale, p_owner_user_id,
    p_project_id, p_decided_at, p_status, p_supersedes_decision_id, p_meeting_id
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'decision.created', 'decision', v_id,
    jsonb_build_object('title', p_title, 'status', p_status)
  );

  -- If this decision supersedes an older one, mark that one as superseded
  IF p_supersedes_decision_id IS NOT NULL THEN
    DECLARE
      v_before_status decision_status;
    BEGIN
      SELECT status INTO v_before_status FROM decisions WHERE id = p_supersedes_decision_id;

      UPDATE decisions SET status = 'superseded' WHERE id = p_supersedes_decision_id;

      INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
      VALUES (
        p_actor_user_id, 'human', 'decision.superseded', 'decision', p_supersedes_decision_id,
        jsonb_build_object('status', v_before_status),
        jsonb_build_object('status', 'superseded', 'superseded_by', v_id)
      );
    END;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid, uuid) TO service_role;
