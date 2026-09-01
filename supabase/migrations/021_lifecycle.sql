-- 021_lifecycle.sql
--
-- Adds close/cancel/reopen lifecycle actions for Projects, Tasks, and Waiting Ons.
--
-- Changes:
--   1. Extend project_status enum with 'cancelled'
--   2. Add completed_at / cancelled_at columns to projects
--   3. New stored procedures:
--        close_project_and_audit
--        cancel_project_and_audit
--        reopen_project_and_audit
--        reopen_task_and_audit
--        reopen_waiting_on_and_audit

-- ---------------------------------------------------------------------------
-- 1. Extend project_status enum
-- ---------------------------------------------------------------------------
ALTER TYPE project_status ADD VALUE IF NOT EXISTS 'cancelled';

-- ---------------------------------------------------------------------------
-- 2. Add timestamp columns to projects
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz;

-- ---------------------------------------------------------------------------
-- 3. close_project_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION close_project_and_audit(
  p_project_id    uuid,
  p_actor_user_id uuid,
  p_before_status text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projects
  SET status = 'completed', completed_at = now(), cancelled_at = NULL
  WHERE id = p_project_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'project.closed', 'project', p_project_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'completed', 'completed_at', now())
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION close_project_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION close_project_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. cancel_project_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_project_and_audit(
  p_project_id    uuid,
  p_actor_user_id uuid,
  p_before_status text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projects
  SET status = 'cancelled', cancelled_at = now(), completed_at = NULL
  WHERE id = p_project_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'project.cancelled', 'project', p_project_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'cancelled', 'cancelled_at', now())
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION cancel_project_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION cancel_project_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. reopen_project_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reopen_project_and_audit(
  p_project_id    uuid,
  p_actor_user_id uuid,
  p_before_status text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projects
  SET status = 'active', completed_at = NULL, cancelled_at = NULL, archived_at = NULL
  WHERE id = p_project_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'project.reopened', 'project', p_project_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'active')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reopen_project_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reopen_project_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. reopen_task_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reopen_task_and_audit(
  p_task_id       uuid,
  p_actor_user_id uuid,
  p_before_status text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks
  SET status = 'open', completed_at = NULL, archived_at = NULL
  WHERE id = p_task_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.reopened', 'task', p_task_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'open')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reopen_task_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reopen_task_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. reopen_waiting_on_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reopen_waiting_on_and_audit(
  p_waiting_on_id uuid,
  p_actor_user_id uuid,
  p_before_status text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE waiting_ons
  SET status = 'open', archived_at = NULL
  WHERE id = p_waiting_on_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'waiting_on.reopened', 'waiting_on', p_waiting_on_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'open')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reopen_waiting_on_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reopen_waiting_on_and_audit(uuid, uuid, text) TO service_role;
