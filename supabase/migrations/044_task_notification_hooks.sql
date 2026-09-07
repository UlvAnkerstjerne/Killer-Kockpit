-- 044_task_notification_hooks.sql
--
-- N3b: Move notification creation inside task lifecycle RPCs.
--
-- MOTIVATION
-- ----------
-- The previous N3 implementation created notifications AFTER the lifecycle
-- RPC returned (two separate network operations).  If the post-RPC
-- INSERT failed, the error was swallowed and the recipient never learned
-- about the event.
--
-- N1 design required all three operations to be atomic:
--   task mutation  +  audit_events INSERT  +  notification INSERT
--
-- This migration moves notification creation INSIDE the five relevant
-- lifecycle RPCs so all three happen within the same PostgreSQL transaction.
-- If the notification INSERT fails, the entire transaction rolls back —
-- no partial state is possible.
--
-- FUNCTIONS MODIFIED
-- ------------------
--   create_task_and_audit            — task.assigned on delegation
--   update_task_and_audit            — task.assigned on genuine reassignment
--   submit_task_for_review_and_audit — task.submitted_for_review
--   approve_task_and_audit           — task.approved
--   send_task_back_and_audit         — task.sent_back
--
-- NOTE: update_task_and_audit_as_admin (005_accountability) calls
--   update_task_and_audit via PERFORM, so it inherits reassignment
--   notifications transparently without modification.
--
-- DUPLICATE PROTECTION
-- --------------------
-- Existing idempotency / state guards fire before the notification INSERT:
--   submit:    early RETURN when already pending_review
--   approve:   RAISE EXCEPTION via NOT FOUND when not pending_review
--   send_back: RAISE EXCEPTION via NOT FOUND when not pending_review
-- These guards prevent duplicate notifications on repeated calls.
-- A UNIQUE constraint on (type, entity_id) is intentionally absent:
-- repeated legitimate lifecycle events (submit → sent_back → submit)
-- must each produce a new notification.
--
-- SELF-NOTIFICATION GUARD
-- -----------------------
-- Every INSERT is conditional on recipient_id != actor_id.
-- Implemented in SQL — no TypeScript guard is required or relied upon.
--
-- SECURITY
-- --------
-- Notification writes happen inside trusted SECURITY DEFINER RPCs.
-- The browser retains no direct INSERT capability on the notifications table.
-- No new public-facing RPC is created.
-- Actor identity is the same p_actor_user_id already used by each transition.
--
-- PERMISSIONS
-- -----------
-- CREATE OR REPLACE preserves existing grants.  REVOKE/GRANT restated
-- explicitly, matching the pattern established in migrations 003 and 022.

-- ─── create_task_and_audit ────────────────────────────────────────────────────
-- Adds task.assigned notification when task is delegated (owner ≠ actor).
-- Self-assigned tasks (owner = actor) produce no notification.

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

  -- Delegated task: notify the assignee.
  -- Self-assigned (actor = owner): no notification.
  IF p_owner_user_id IS NOT NULL AND p_owner_user_id != p_actor_user_id THEN
    INSERT INTO notifications (type, entity_type, entity_id, recipient_user_id, actor_user_id)
    VALUES ('task.assigned', 'task', v_id, p_owner_user_id, p_actor_user_id);
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_task_and_audit(text, text, uuid, uuid, text, smallint, timestamptz, uuid, uuid) TO service_role;

-- ─── update_task_and_audit ────────────────────────────────────────────────────
-- Adds task.assigned notification on genuine owner_user_id change.
--
-- Detection:
--   1. If patch contains 'owner_user_id', lock the row and read current owner.
--   2. After mutation, compare old vs new.
--   3. Notify only when: new owner is non-null, different from old owner,
--      and different from the actor (no self-notifications).
--
-- The FOR UPDATE in the initial SELECT prevents a race where two concurrent
-- updates both see the same old owner and both fire a notification.

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
  v_field     text;
  v_old_owner uuid;
  v_new_owner uuid;
BEGIN
  -- Read and lock current owner only when the patch includes owner_user_id.
  IF p_patch ? 'owner_user_id' THEN
    SELECT owner_user_id INTO v_old_owner
    FROM   tasks
    WHERE  id = p_task_id
    FOR UPDATE;

    v_new_owner := (p_patch->>'owner_user_id')::uuid;
  END IF;

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

  -- Notify on genuine reassignment only.
  -- IS DISTINCT FROM handles null vs non-null comparisons correctly.
  IF p_patch ? 'owner_user_id'
     AND v_new_owner IS NOT NULL
     AND v_new_owner IS DISTINCT FROM v_old_owner
     AND v_new_owner != p_actor_user_id
  THEN
    INSERT INTO notifications (type, entity_type, entity_id, recipient_user_id, actor_user_id)
    VALUES ('task.assigned', 'task', p_task_id, v_new_owner, p_actor_user_id);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION update_task_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ─── submit_task_for_review_and_audit ────────────────────────────────────────
-- Adds task.submitted_for_review notification to created_by_user_id (the owner).
--
-- The existing idempotency guard (early RETURN when already pending_review)
-- fires before the notification INSERT, preventing duplicates on repeated calls.
-- created_by_user_id is fetched in the existing FOR UPDATE SELECT.

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
  v_status     task_status;
  v_created_by uuid;
BEGIN
  SELECT status, created_by_user_id
  INTO   v_status, v_created_by
  FROM   tasks
  WHERE  id = p_task_id
  FOR UPDATE;

  -- Idempotency: already submitted → RETURN before notification.
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

  -- Notify the owner (created_by_user_id) that review is requested.
  -- Skip when submitter is the owner themselves (self-assigned task context).
  IF v_created_by IS NOT NULL AND v_created_by != p_actor_user_id THEN
    INSERT INTO notifications (type, entity_type, entity_id, recipient_user_id, actor_user_id)
    VALUES ('task.submitted_for_review', 'task', p_task_id, v_created_by, p_actor_user_id);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_task_for_review_and_audit(uuid, uuid, text) TO service_role;

-- ─── approve_task_and_audit ───────────────────────────────────────────────────
-- Adds task.approved notification to the responsible person (owner_user_id).
--
-- RETURNING owner_user_id captures the value in the same UPDATE statement.
-- The NOT FOUND guard (RAISE EXCEPTION) prevents duplicate approval and
-- therefore prevents duplicate notifications.

CREATE OR REPLACE FUNCTION approve_task_and_audit(
  p_task_id        uuid,
  p_actor_user_id  uuid,
  p_now            timestamptz
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid;
BEGIN
  UPDATE tasks SET
    status               = 'done',
    completed_at         = p_now,
    approved_by_user_id  = p_actor_user_id,
    approved_at          = p_now,
    updated_at           = p_now
  WHERE  id = p_task_id AND status = 'pending_review'
  RETURNING owner_user_id INTO v_owner;

  -- NOT FOUND: task was not in pending_review (already approved or wrong state).
  -- This also prevents duplicate notifications on repeated calls.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % is not in pending_review state', p_task_id;
  END IF;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.approved', 'task', p_task_id,
    jsonb_build_object('status', 'pending_review'),
    jsonb_build_object('status', 'done', 'completed_at', p_now)
  );

  -- Notify the responsible person that their work was approved.
  IF v_owner IS NOT NULL AND v_owner != p_actor_user_id THEN
    INSERT INTO notifications (type, entity_type, entity_id, recipient_user_id, actor_user_id)
    VALUES ('task.approved', 'task', p_task_id, v_owner, p_actor_user_id);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION approve_task_and_audit(uuid, uuid, timestamptz) TO service_role;

-- ─── send_task_back_and_audit ─────────────────────────────────────────────────
-- Adds task.sent_back notification to the responsible person (owner_user_id).
--
-- Same pattern as approve_task_and_audit: RETURNING captures owner_user_id,
-- NOT FOUND guard prevents duplicates.

CREATE OR REPLACE FUNCTION send_task_back_and_audit(
  p_task_id        uuid,
  p_actor_user_id  uuid,
  p_review_note    text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid;
BEGIN
  UPDATE tasks SET
    status               = 'open',
    returned_by_user_id  = p_actor_user_id,
    returned_at          = now(),
    latest_review_note   = p_review_note,
    updated_at           = now()
  WHERE  id = p_task_id AND status = 'pending_review'
  RETURNING owner_user_id INTO v_owner;

  -- NOT FOUND: task was not in pending_review.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task % is not in pending_review state', p_task_id;
  END IF;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'task.sent_back', 'task', p_task_id,
    jsonb_build_object('status', 'pending_review'),
    jsonb_build_object('status', 'open', 'review_note', p_review_note)
  );

  -- Notify the responsible person that their work was sent back for revision.
  IF v_owner IS NOT NULL AND v_owner != p_actor_user_id THEN
    INSERT INTO notifications (type, entity_type, entity_id, recipient_user_id, actor_user_id)
    VALUES ('task.sent_back', 'task', p_task_id, v_owner, p_actor_user_id);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION send_task_back_and_audit(uuid, uuid, text) TO service_role;
