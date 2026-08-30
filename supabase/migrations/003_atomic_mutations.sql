-- Atomic mutation + audit stored procedures.
--
-- Each function performs a business mutation AND inserts the corresponding
-- audit_events row(s) inside a single PostgreSQL transaction.  Either both
-- succeed or neither does — the guarantee the application layer cannot
-- provide when making two separate network calls.
--
-- SECURITY DEFINER runs the function as its owner (postgres/superuser),
-- bypassing RLS so audit_events can be written regardless of the caller's
-- session role.  SET search_path = public prevents search-path injection.
--
-- EXECUTE is explicitly revoked from PUBLIC (which includes the anon and
-- authenticated Supabase roles) and granted only to service_role.  A
-- browser-authenticated user calling the Supabase REST API therefore
-- cannot invoke these functions directly and bypass the application
-- permission layer.  All permission checks (ownership, role) are enforced
-- in the TypeScript server action before the RPC is called.

-- ---------------------------------------------------------------------------
-- create_project_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_project_and_audit(
  p_title              text,
  p_description        text,
  p_owner_user_id      uuid,
  p_status             text,
  p_start_date         date,
  p_due_date           date,
  p_progress           numeric,
  p_created_by_user_id uuid,
  p_actor_user_id      uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO projects (
    title, description, owner_user_id, status,
    start_date, due_date, progress, created_by_user_id
  ) VALUES (
    p_title, p_description, p_owner_user_id, p_status::project_status,
    p_start_date, p_due_date, p_progress, p_created_by_user_id
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'project.created', 'project', v_id,
    jsonb_build_object(
      'title',         p_title,
      'status',        p_status,
      'owner_user_id', p_owner_user_id
    )
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_project_and_audit(text, text, uuid, text, date, date, numeric, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_project_and_audit(text, text, uuid, text, date, date, numeric, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_project_and_audit
--
-- p_patch  — JSONB object containing only the changed fields with new values
--            e.g. {"title": "New Name", "status": "blocked"}
-- p_before — JSONB object with the old values for those same fields
--            e.g. {"title": "Old Name", "status": "active"}
--
-- The UPDATE uses static CASE expressions (no dynamic SQL) so each column
-- type is cast explicitly.  Unchanged fields are left untouched via ELSE.
-- One audit_events row is inserted per changed field, preserving full
-- per-field history.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_project_and_audit(
  p_project_id    uuid,
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
  UPDATE projects SET
    title         = CASE WHEN p_patch ? 'title'         THEN  p_patch->>'title'                          ELSE title         END,
    description   = CASE WHEN p_patch ? 'description'   THEN  p_patch->>'description'                    ELSE description   END,
    owner_user_id = CASE WHEN p_patch ? 'owner_user_id' THEN (p_patch->>'owner_user_id')::uuid           ELSE owner_user_id END,
    status        = CASE WHEN p_patch ? 'status'        THEN (p_patch->>'status')::project_status        ELSE status        END,
    start_date    = CASE WHEN p_patch ? 'start_date'    THEN (p_patch->>'start_date')::date              ELSE start_date    END,
    due_date      = CASE WHEN p_patch ? 'due_date'      THEN (p_patch->>'due_date')::date                ELSE due_date      END,
    progress      = CASE WHEN p_patch ? 'progress'      THEN (p_patch->>'progress')::numeric             ELSE progress      END
  WHERE id = p_project_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'project.' || v_field || '.changed',
      'project', p_project_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_project_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_project_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- archive_project_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_project_and_audit(
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
  SET archived_at = now(), status = 'archived'
  WHERE id = p_project_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'project.archived', 'project', p_project_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'archived')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION archive_project_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION archive_project_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- create_task_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_task_and_audit(
  p_title              text,
  p_description        text,
  p_owner_user_id      uuid,
  p_project_id         uuid,
  p_status             text,
  p_priority           smallint,
  p_due_at             timestamptz,
  p_created_by_user_id uuid,
  p_actor_user_id      uuid
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
    status, priority, due_at, created_by_user_id
  ) VALUES (
    p_title, p_description, p_owner_user_id, p_project_id,
    p_status::task_status, p_priority, p_due_at, p_created_by_user_id
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

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_task_and_audit
--
-- Same JSONB patch pattern as update_project_and_audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_task_and_audit(
  p_task_id       uuid,
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
  UPDATE tasks SET
    title         = CASE WHEN p_patch ? 'title'         THEN  p_patch->>'title'                        ELSE title         END,
    description   = CASE WHEN p_patch ? 'description'   THEN  p_patch->>'description'                  ELSE description   END,
    owner_user_id = CASE WHEN p_patch ? 'owner_user_id' THEN (p_patch->>'owner_user_id')::uuid         ELSE owner_user_id END,
    project_id    = CASE WHEN p_patch ? 'project_id'    THEN (p_patch->>'project_id')::uuid            ELSE project_id    END,
    status        = CASE WHEN p_patch ? 'status'        THEN (p_patch->>'status')::task_status         ELSE status        END,
    priority      = CASE WHEN p_patch ? 'priority'      THEN (p_patch->>'priority')::smallint          ELSE priority      END,
    due_at        = CASE WHEN p_patch ? 'due_at'        THEN (p_patch->>'due_at')::timestamptz         ELSE due_at        END
  WHERE id = p_task_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'task.' || v_field || '.changed',
      'task', p_task_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- complete_task_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_task_and_audit(
  p_task_id       uuid,
  p_actor_user_id uuid,
  p_before_status text,
  p_now           timestamptz
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks
  SET status = 'done', completed_at = p_now
  WHERE id = p_task_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.completed', 'task', p_task_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'done', 'completed_at', p_now)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION complete_task_and_audit(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION complete_task_and_audit(uuid, uuid, text, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- cancel_task_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_task_and_audit(
  p_task_id       uuid,
  p_actor_user_id uuid,
  p_before_status text,
  p_now           timestamptz
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks
  SET status = 'cancelled', archived_at = p_now
  WHERE id = p_task_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.cancelled', 'task', p_task_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'cancelled')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION cancel_task_and_audit(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION cancel_task_and_audit(uuid, uuid, text, timestamptz) TO service_role;
