-- Killer Kockpit — Milestone 3 Accountability Pass
--
-- Principle: role determines what you can see/do organisationally;
-- relationship to the object determines whether you may alter that
-- particular commitment.
--
-- Changes:
--   1. change_requests table — human-initiated requests to modify a task's
--      commitment terms (due date, scope, assignee).  Service-role only
--      for writes; RLS exposes records to relevant parties for reading.
--   2. New stored procedures (all SECURITY DEFINER, service_role only):
--        create_change_request_and_audit
--        approve_change_request_and_audit        (atomic: apply patch + audit)
--        reject_change_request_and_audit
--        update_{entity}_and_audit_as_admin × 4  (atomic: mutation + mandatory admin.override audit)

-- ---------------------------------------------------------------------------
-- change_requests
-- ---------------------------------------------------------------------------

CREATE TABLE change_requests (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text        NOT NULL CHECK (entity_type IN ('task')),
  entity_id        uuid        NOT NULL,
  requester_id     uuid        NOT NULL REFERENCES app_users(id),
  proposed_changes jsonb       NOT NULL,
  reason           text,
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_id   uuid        REFERENCES app_users(id),
  review_note      text,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX change_requests_entity_idx  ON change_requests(entity_type, entity_id);
CREATE INDEX change_requests_requester_idx ON change_requests(requester_id);
CREATE INDEX change_requests_pending_idx ON change_requests(status) WHERE status = 'pending';

CREATE TRIGGER change_requests_updated_at
  BEFORE UPDATE ON change_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- RLS — change_requests
-- ---------------------------------------------------------------------------

ALTER TABLE change_requests ENABLE ROW LEVEL SECURITY;

-- Management roles see everything
CREATE POLICY "change_requests: management can read all"
  ON change_requests FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Requesters see their own requests
CREATE POLICY "change_requests: requester can read own"
  ON change_requests FOR SELECT
  TO authenticated
  USING (requester_id = get_my_app_user_id());

-- Task creator sees incoming change requests for their tasks
CREATE POLICY "change_requests: task creator sees incoming"
  ON change_requests FOR SELECT
  TO authenticated
  USING (
    entity_type = 'task'
    AND entity_id IN (
      SELECT id FROM tasks WHERE created_by_user_id = get_my_app_user_id()
    )
  );

-- No direct writes — all mutations go through service_role RPCs
CREATE POLICY "change_requests: no direct insert"
  ON change_requests FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY "change_requests: no direct update"
  ON change_requests FOR UPDATE
  TO authenticated
  USING (false);

-- ---------------------------------------------------------------------------
-- create_change_request_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_change_request_and_audit(
  p_entity_type       text,
  p_entity_id         uuid,
  p_requester_id      uuid,
  p_proposed_changes  jsonb,
  p_reason            text
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO change_requests (entity_type, entity_id, requester_id, proposed_changes, reason)
  VALUES (p_entity_type, p_entity_id, p_requester_id, p_proposed_changes, p_reason)
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_requester_id, 'human', 'change_request.created',
    p_entity_type, p_entity_id,
    jsonb_build_object(
      'change_request_id', v_id,
      'proposed_changes',  p_proposed_changes,
      'reason',            p_reason
    )
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_change_request_and_audit(text, uuid, uuid, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_change_request_and_audit(text, uuid, uuid, jsonb, text) TO service_role;

-- ---------------------------------------------------------------------------
-- approve_change_request_and_audit
--
-- Atomically:
--   1. Marks the change_request approved
--   2. Applies proposed_changes to the task row
--   3. Inserts audit events (approval + per-field change events)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION approve_change_request_and_audit(
  p_change_request_id uuid,
  p_reviewer_id       uuid,
  p_review_note       text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_cr    change_requests%ROWTYPE;
  v_field text;
BEGIN
  SELECT * INTO v_cr
  FROM change_requests
  WHERE id = p_change_request_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change request % not found or not pending', p_change_request_id;
  END IF;

  -- Mark approved
  UPDATE change_requests
  SET status         = 'approved',
      reviewed_by_id = p_reviewer_id,
      review_note    = p_review_note,
      reviewed_at    = now()
  WHERE id = p_change_request_id;

  -- Apply changes to task
  IF v_cr.entity_type = 'task' THEN
    UPDATE tasks SET
      title         = CASE WHEN v_cr.proposed_changes ? 'title'
                           THEN  v_cr.proposed_changes->>'title'                          ELSE title         END,
      description   = CASE WHEN v_cr.proposed_changes ? 'description'
                           THEN  v_cr.proposed_changes->>'description'                    ELSE description   END,
      owner_user_id = CASE WHEN v_cr.proposed_changes ? 'owner_user_id'
                           THEN (v_cr.proposed_changes->>'owner_user_id')::uuid           ELSE owner_user_id END,
      project_id    = CASE WHEN v_cr.proposed_changes ? 'project_id'
                           THEN (v_cr.proposed_changes->>'project_id')::uuid              ELSE project_id    END,
      priority      = CASE WHEN v_cr.proposed_changes ? 'priority'
                           THEN (v_cr.proposed_changes->>'priority')::smallint            ELSE priority      END,
      due_at        = CASE WHEN v_cr.proposed_changes ? 'due_at'
                           THEN (v_cr.proposed_changes->>'due_at')::timestamptz           ELSE due_at        END
    WHERE id = v_cr.entity_id;
  END IF;

  -- Audit: approval event
  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_reviewer_id, 'human', 'change_request.approved',
    v_cr.entity_type, v_cr.entity_id,
    jsonb_build_object(
      'change_request_id', p_change_request_id,
      'applied_changes',   v_cr.proposed_changes,
      'review_note',       p_review_note
    )
  );

  -- Audit: per-field change events (mirrors update_task_and_audit pattern)
  FOR v_field IN SELECT jsonb_object_keys(v_cr.proposed_changes)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json, metadata)
    VALUES (
      p_reviewer_id, 'human',
      v_cr.entity_type || '.' || v_field || '.changed',
      v_cr.entity_type, v_cr.entity_id,
      jsonb_build_object(v_field, v_cr.proposed_changes->v_field),
      jsonb_build_object('via_change_request', p_change_request_id)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION approve_change_request_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION approve_change_request_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- reject_change_request_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_change_request_and_audit(
  p_change_request_id uuid,
  p_reviewer_id       uuid,
  p_review_note       text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_cr change_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_cr
  FROM change_requests
  WHERE id = p_change_request_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change request % not found or not pending', p_change_request_id;
  END IF;

  UPDATE change_requests
  SET status         = 'rejected',
      reviewed_by_id = p_reviewer_id,
      review_note    = p_review_note,
      reviewed_at    = now()
  WHERE id = p_change_request_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_reviewer_id, 'human', 'change_request.rejected',
    v_cr.entity_type, v_cr.entity_id,
    jsonb_build_object(
      'change_request_id', p_change_request_id,
      'rejected_changes',  v_cr.proposed_changes,
      'review_note',       p_review_note
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reject_change_request_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reject_change_request_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Admin-override atomic wrappers
--
-- Each wrapper calls the standard mutation procedure and then inserts a
-- mandatory admin.override audit event within the SAME transaction.
-- If either step fails the entire transaction rolls back — a SUPER_ADMIN
-- override may not succeed without its audit record also succeeding.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_project_and_audit_as_admin(
  p_project_id    uuid,
  p_actor_user_id uuid,
  p_patch         jsonb,
  p_before        jsonb,
  p_override_note text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM update_project_and_audit(p_project_id, p_actor_user_id, p_patch, p_before);

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json, metadata)
  VALUES (
    p_actor_user_id, 'human', 'admin.override',
    'project', p_project_id,
    jsonb_build_object('note', p_override_note),
    jsonb_build_object('is_admin_override', true)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION update_project_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_project_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) TO service_role;


CREATE OR REPLACE FUNCTION update_task_and_audit_as_admin(
  p_task_id       uuid,
  p_actor_user_id uuid,
  p_patch         jsonb,
  p_before        jsonb,
  p_override_note text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM update_task_and_audit(p_task_id, p_actor_user_id, p_patch, p_before);

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json, metadata)
  VALUES (
    p_actor_user_id, 'human', 'admin.override',
    'task', p_task_id,
    jsonb_build_object('note', p_override_note),
    jsonb_build_object('is_admin_override', true)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION update_task_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_task_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) TO service_role;


CREATE OR REPLACE FUNCTION update_waiting_on_and_audit_as_admin(
  p_waiting_on_id uuid,
  p_actor_user_id uuid,
  p_patch         jsonb,
  p_before        jsonb,
  p_override_note text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM update_waiting_on_and_audit(p_waiting_on_id, p_actor_user_id, p_patch, p_before);

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json, metadata)
  VALUES (
    p_actor_user_id, 'human', 'admin.override',
    'waiting_on', p_waiting_on_id,
    jsonb_build_object('note', p_override_note),
    jsonb_build_object('is_admin_override', true)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_waiting_on_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) TO service_role;


CREATE OR REPLACE FUNCTION update_decision_and_audit_as_admin(
  p_decision_id   uuid,
  p_actor_user_id uuid,
  p_patch         jsonb,
  p_before        jsonb,
  p_override_note text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM update_decision_and_audit(p_decision_id, p_actor_user_id, p_patch, p_before);

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json, metadata)
  VALUES (
    p_actor_user_id, 'human', 'admin.override',
    'decision', p_decision_id,
    jsonb_build_object('note', p_override_note),
    jsonb_build_object('is_admin_override', true)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION update_decision_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_decision_and_audit_as_admin(uuid, uuid, jsonb, jsonb, text) TO service_role;
