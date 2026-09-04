-- 032_task_handoff.sql
--
-- Adds the handoff / review lifecycle to tasks.
--
-- Design
-- ------
-- • pending_review (added to task_status in 031) is the new lifecycle state.
--   The responsible person (owner_user_id) submits their work; the requester
--   (created_by_user_id) then approves (→ done) or sends back (→ open).
--
-- • Self-assigned tasks (owner == creator) skip the review step.
--   The application layer enforces this; no DB constraint is needed.
--
-- • submitted_by_user_id / submitted_at track the LATEST submission only.
--   Overwritten on resubmit.  Full history is preserved in audit_events.
--
-- • returned_by_user_id / returned_at / latest_review_note are cleared when
--   the responsible person resubmits (via submit_task_for_review_and_audit),
--   so the "Returned to you" Today signal disappears automatically.

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN submitted_by_user_id  uuid REFERENCES app_users(id),
  ADD COLUMN submitted_at          timestamptz,
  ADD COLUMN approved_by_user_id   uuid REFERENCES app_users(id),
  ADD COLUMN approved_at           timestamptz,
  ADD COLUMN returned_by_user_id   uuid REFERENCES app_users(id),
  ADD COLUMN returned_at           timestamptz,
  ADD COLUMN latest_review_note    text;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Today page: requester sees tasks they need to review
CREATE INDEX tasks_pending_review_requester_idx
  ON tasks (created_by_user_id, status)
  WHERE status = 'pending_review'
    AND archived_at IS NULL;

-- Today page: responsible person sees tasks returned to them
CREATE INDEX tasks_returned_to_owner_idx
  ON tasks (owner_user_id, returned_at)
  WHERE returned_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- submit_task_for_review_and_audit
-- ---------------------------------------------------------------------------
-- Transitions open/in_progress/blocked → pending_review.
-- Clears any previous return signal (idempotent if already pending_review).

CREATE OR REPLACE FUNCTION submit_task_for_review_and_audit(
  p_task_id        uuid,
  p_actor_user_id  uuid,
  p_before_status  text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_status task_status;
BEGIN
  SELECT status INTO v_status FROM tasks WHERE id = p_task_id FOR UPDATE;

  IF v_status = 'pending_review' THEN RETURN; END IF;

  IF v_status NOT IN ('open', 'in_progress', 'blocked') THEN
    RAISE EXCEPTION 'Cannot submit task from status %', v_status;
  END IF;

  UPDATE tasks SET
    status               = 'pending_review',
    submitted_by_user_id = p_actor_user_id,
    submitted_at         = now(),
    returned_by_user_id  = NULL,
    returned_at          = NULL,
    latest_review_note   = NULL,
    updated_at           = now()
  WHERE id = p_task_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.submitted_for_review', 'task', p_task_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'pending_review')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- approve_task_and_audit
-- ---------------------------------------------------------------------------
-- Requester approves submitted work → status becomes done.

CREATE OR REPLACE FUNCTION approve_task_and_audit(
  p_task_id        uuid,
  p_actor_user_id  uuid,
  p_now            timestamptz
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks SET
    status               = 'done',
    completed_at         = p_now,
    approved_by_user_id  = p_actor_user_id,
    approved_at          = p_now,
    updated_at           = p_now
  WHERE id = p_task_id AND status = 'pending_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % is not in pending_review state', p_task_id;
  END IF;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.approved', 'task', p_task_id,
    jsonb_build_object('status', 'pending_review'),
    jsonb_build_object('status', 'done', 'completed_at', p_now)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- send_task_back_and_audit
-- ---------------------------------------------------------------------------
-- Requester sends task back → status returns to open.
-- Sets returned_* fields so responsible person sees the Today signal.

CREATE OR REPLACE FUNCTION send_task_back_and_audit(
  p_task_id        uuid,
  p_actor_user_id  uuid,
  p_review_note    text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks SET
    status               = 'open',
    returned_by_user_id  = p_actor_user_id,
    returned_at          = now(),
    latest_review_note   = p_review_note,
    updated_at           = now()
  WHERE id = p_task_id AND status = 'pending_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % is not in pending_review state', p_task_id;
  END IF;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.sent_back', 'task', p_task_id,
    jsonb_build_object('status', 'pending_review'),
    jsonb_build_object('status', 'open', 'review_note', p_review_note)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) TO service_role;
