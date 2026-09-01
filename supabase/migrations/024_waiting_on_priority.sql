-- 024_waiting_on_priority.sql
--
-- Adds priority and fulfilled_at to waiting_ons.
--
-- Changes:
--   1. waiting_ons.priority  smallint NOT NULL DEFAULT 2 CHECK (1–4)
--      Same model as tasks.priority — 1=Critical, 2=Normal, 3=Low, 4=Background.
--   2. waiting_ons.fulfilled_at  timestamptz
--      Populated when a waiting on is fulfilled. Backfilled from updated_at
--      for existing fulfilled rows (reasonable approximation).
--   3. Updated RPCs:
--        create_waiting_on_and_audit  — accepts optional p_priority (DEFAULT 2)
--        update_waiting_on_and_audit  — handles 'priority' key in jsonb patch
--        fulfill_waiting_on_and_audit — sets fulfilled_at = now()
--
-- Security model: same REVOKE/GRANT pattern as all existing RPCs.

-- ---------------------------------------------------------------------------
-- 1. Schema changes
-- ---------------------------------------------------------------------------

ALTER TABLE waiting_ons
  ADD COLUMN IF NOT EXISTS priority     smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

-- Backfill: use updated_at as an approximation for when existing rows were fulfilled.
UPDATE waiting_ons
SET fulfilled_at = updated_at
WHERE status = 'fulfilled'
  AND fulfilled_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. create_waiting_on_and_audit
--    Adds optional p_priority parameter (DEFAULT 2 so existing callers are unaffected).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_waiting_on_and_audit(
  p_title                  text,
  p_owner_user_id          uuid,
  p_waiting_for_user_id    uuid,
  p_waiting_for_name       text,
  p_project_id             uuid,
  p_due_at                 timestamptz,
  p_notes                  text,
  p_actor_user_id          uuid,
  p_priority               smallint DEFAULT 2
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
    waiting_for_name, project_id, due_at, notes, status, priority
  ) VALUES (
    p_title, p_owner_user_id, p_waiting_for_user_id,
    p_waiting_for_name, p_project_id, p_due_at, p_notes, 'open', p_priority
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

REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint) FROM anon;
REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid, smallint) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. update_waiting_on_and_audit
--    Extends the SET clause to handle 'priority' in the jsonb patch.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_waiting_on_and_audit(
  p_waiting_on_id uuid,
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
  UPDATE waiting_ons SET
    title                = CASE WHEN p_patch ? 'title'                THEN  p_patch->>'title'                            ELSE title                END,
    notes                = CASE WHEN p_patch ? 'notes'                THEN  p_patch->>'notes'                            ELSE notes                END,
    waiting_for_user_id  = CASE WHEN p_patch ? 'waiting_for_user_id'  THEN (p_patch->>'waiting_for_user_id')::uuid       ELSE waiting_for_user_id  END,
    waiting_for_name     = CASE WHEN p_patch ? 'waiting_for_name'     THEN  p_patch->>'waiting_for_name'                 ELSE waiting_for_name     END,
    project_id           = CASE WHEN p_patch ? 'project_id'           THEN (p_patch->>'project_id')::uuid               ELSE project_id           END,
    due_at               = CASE WHEN p_patch ? 'due_at'               THEN (p_patch->>'due_at')::timestamptz             ELSE due_at               END,
    status               = CASE WHEN p_patch ? 'status'               THEN (p_patch->>'status')::waiting_status          ELSE status               END,
    priority             = CASE WHEN p_patch ? 'priority'             THEN (p_patch->>'priority')::smallint              ELSE priority             END
  WHERE id = p_waiting_on_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'waiting_on.' || v_field || '.changed',
      'waiting_on', p_waiting_on_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION update_waiting_on_and_audit(uuid, uuid, jsonb, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION update_waiting_on_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. fulfill_waiting_on_and_audit
--    Sets fulfilled_at = now() in addition to status = 'fulfilled'.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fulfill_waiting_on_and_audit(
  p_waiting_on_id uuid,
  p_actor_user_id uuid,
  p_before_status waiting_status
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE waiting_ons
  SET status = 'fulfilled', fulfilled_at = now()
  WHERE id = p_waiting_on_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'waiting_on.fulfilled', 'waiting_on', p_waiting_on_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'fulfilled', 'fulfilled_at', now())
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) FROM anon;
REVOKE EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) FROM authenticated;
GRANT  EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) TO service_role;
