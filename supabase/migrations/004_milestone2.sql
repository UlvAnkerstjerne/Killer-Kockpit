-- Killer Kockpit — Milestone 2: Management Core
--
-- Schema changes:
--   1. Make app_users.google_subject_id nullable (pre-approved users have no
--      Google identity yet — it is bound atomically on first login).
--   2. Add notes to waiting_ons.
--   3. Add rationale and owner_user_id to decisions.
--
-- RLS:
--   Replace the blanket "SUPER_ADMIN only" policies on waiting_ons and
--   decisions with proper role-based policies.
--
-- Stored procedures (SECURITY DEFINER, restricted to service_role):
--   User management:  create_app_user_and_audit
--                     update_app_user_role_and_audit
--                     set_app_user_active_and_audit
--                     bind_user_identity_and_audit
--   Waiting Ons:      create_waiting_on_and_audit
--                     update_waiting_on_and_audit
--                     fulfill_waiting_on_and_audit
--                     cancel_waiting_on_and_audit
--   Decisions:        create_decision_and_audit
--                     update_decision_and_audit
--                     approve_decision_and_audit
--                     supersede_decision_and_audit

-- ---------------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------------

ALTER TABLE app_users ALTER COLUMN google_subject_id DROP NOT NULL;

ALTER TABLE waiting_ons ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS rationale text;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS owner_user_id uuid references app_users(id);

-- ---------------------------------------------------------------------------
-- RLS — waiting_ons
-- ---------------------------------------------------------------------------

-- Drop blanket SUPER_ADMIN policy
DROP POLICY IF EXISTS "waiting_ons: SUPER_ADMIN only" ON waiting_ons;

-- SUPER_ADMIN and UM: see all non-archived waiting ons
CREATE POLICY "waiting_ons: management can read all"
  ON waiting_ons FOR SELECT
  TO authenticated
  USING (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND archived_at IS NULL
  );

-- MEMBER: see their own waiting ons
CREATE POLICY "waiting_ons: member can read own"
  ON waiting_ons FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND owner_user_id = get_my_app_user_id()
    AND archived_at IS NULL
  );

-- Management can read archived waiting ons
CREATE POLICY "waiting_ons: management can read archived"
  ON waiting_ons FOR SELECT
  TO authenticated
  USING (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND archived_at IS NOT NULL
  );

-- Any authenticated active user can create waiting ons
CREATE POLICY "waiting_ons: authenticated can insert"
  ON waiting_ons FOR INSERT
  TO authenticated
  WITH CHECK (get_my_app_user_id() IS NOT NULL);

-- SUPER_ADMIN and UM can update any waiting on
CREATE POLICY "waiting_ons: management can update any"
  ON waiting_ons FOR UPDATE
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- MEMBER can only update waiting ons they own
CREATE POLICY "waiting_ons: member can update own"
  ON waiting_ons FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND owner_user_id = get_my_app_user_id()
  );

-- ---------------------------------------------------------------------------
-- RLS — decisions
-- ---------------------------------------------------------------------------

-- Drop blanket SUPER_ADMIN policy
DROP POLICY IF EXISTS "decisions: SUPER_ADMIN only" ON decisions;

-- All authenticated users can read decisions (org-level knowledge)
CREATE POLICY "decisions: authenticated can read"
  ON decisions FOR SELECT
  TO authenticated
  USING (
    get_my_app_user_id() IS NOT NULL
    AND archived_at IS NULL
  );

-- Management can read archived decisions
CREATE POLICY "decisions: management can read archived"
  ON decisions FOR SELECT
  TO authenticated
  USING (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND archived_at IS NOT NULL
  );

-- Only management can create decisions
CREATE POLICY "decisions: management can insert"
  ON decisions FOR INSERT
  TO authenticated
  WITH CHECK (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Only management can update decisions
CREATE POLICY "decisions: management can update"
  ON decisions FOR UPDATE
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- ---------------------------------------------------------------------------
-- create_app_user_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_app_user_and_audit(
  p_email        text,
  p_display_name text,
  p_role         kk_role,
  p_actor_user_id uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO app_users (email, display_name, role, active)
  VALUES (p_email, p_display_name, p_role, true)
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'user.created', 'user', v_id,
    jsonb_build_object('email', p_email, 'display_name', p_display_name, 'role', p_role)
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_app_user_and_audit(text, text, kk_role, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_app_user_and_audit(text, text, kk_role, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_app_user_role_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_app_user_role_and_audit(
  p_user_id       uuid,
  p_new_role      kk_role,
  p_before_role   kk_role,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app_users SET role = p_new_role WHERE id = p_user_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'user.role.changed', 'user', p_user_id,
    jsonb_build_object('role', p_before_role),
    jsonb_build_object('role', p_new_role)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION update_app_user_role_and_audit(uuid, kk_role, kk_role, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_app_user_role_and_audit(uuid, kk_role, kk_role, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- set_app_user_active_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_app_user_active_and_audit(
  p_user_id       uuid,
  p_active        boolean,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_before_active boolean;
BEGIN
  SELECT active INTO v_before_active FROM app_users WHERE id = p_user_id;

  UPDATE app_users SET active = p_active WHERE id = p_user_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human',
    CASE WHEN p_active THEN 'user.activated' ELSE 'user.deactivated' END,
    'user', p_user_id,
    jsonb_build_object('active', v_before_active),
    jsonb_build_object('active', p_active)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION set_app_user_active_and_audit(uuid, boolean, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION set_app_user_active_and_audit(uuid, boolean, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- bind_user_identity_and_audit
-- Atomically binds google_subject_id + auth_user_id + display_name on first
-- login for a pre-approved user (google_subject_id was NULL before).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bind_user_identity_and_audit(
  p_user_id           uuid,
  p_google_subject_id text,
  p_auth_user_id      uuid,
  p_display_name      text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app_users
  SET
    google_subject_id = p_google_subject_id,
    auth_user_id      = p_auth_user_id,
    display_name      = p_display_name
  WHERE id = p_user_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_user_id, 'human', 'user.identity_bound', 'user', p_user_id,
    jsonb_build_object('display_name', p_display_name)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION bind_user_identity_and_audit(uuid, text, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION bind_user_identity_and_audit(uuid, text, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- create_waiting_on_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_waiting_on_and_audit(
  p_title                  text,
  p_owner_user_id          uuid,
  p_waiting_for_user_id    uuid,
  p_waiting_for_name       text,
  p_project_id             uuid,
  p_due_at                 timestamptz,
  p_notes                  text,
  p_actor_user_id          uuid
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
    waiting_for_name, project_id, due_at, notes, status
  ) VALUES (
    p_title, p_owner_user_id, p_waiting_for_user_id,
    p_waiting_for_name, p_project_id, p_due_at, p_notes, 'open'
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'waiting_on.created', 'waiting_on', v_id,
    jsonb_build_object('title', p_title, 'status', 'open')
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_waiting_on_and_audit(text, uuid, uuid, text, uuid, timestamptz, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_waiting_on_and_audit
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
    title                = CASE WHEN p_patch ? 'title'             THEN  p_patch->>'title'                           ELSE title                END,
    notes                = CASE WHEN p_patch ? 'notes'             THEN  p_patch->>'notes'                           ELSE notes                END,
    waiting_for_user_id  = CASE WHEN p_patch ? 'waiting_for_user_id' THEN (p_patch->>'waiting_for_user_id')::uuid   ELSE waiting_for_user_id  END,
    waiting_for_name     = CASE WHEN p_patch ? 'waiting_for_name'  THEN  p_patch->>'waiting_for_name'               ELSE waiting_for_name     END,
    project_id           = CASE WHEN p_patch ? 'project_id'        THEN (p_patch->>'project_id')::uuid              ELSE project_id           END,
    due_at               = CASE WHEN p_patch ? 'due_at'            THEN (p_patch->>'due_at')::timestamptz           ELSE due_at               END,
    status               = CASE WHEN p_patch ? 'status'            THEN (p_patch->>'status')::waiting_status        ELSE status               END
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
GRANT  EXECUTE ON FUNCTION update_waiting_on_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- fulfill_waiting_on_and_audit
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
  UPDATE waiting_ons SET status = 'fulfilled' WHERE id = p_waiting_on_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'waiting_on.fulfilled', 'waiting_on', p_waiting_on_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'fulfilled')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION fulfill_waiting_on_and_audit(uuid, uuid, waiting_status) TO service_role;

-- ---------------------------------------------------------------------------
-- cancel_waiting_on_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_waiting_on_and_audit(
  p_waiting_on_id uuid,
  p_actor_user_id uuid,
  p_before_status waiting_status
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE waiting_ons SET status = 'cancelled', archived_at = now() WHERE id = p_waiting_on_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'waiting_on.cancelled', 'waiting_on', p_waiting_on_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'cancelled')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION cancel_waiting_on_and_audit(uuid, uuid, waiting_status) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION cancel_waiting_on_and_audit(uuid, uuid, waiting_status) TO service_role;

-- ---------------------------------------------------------------------------
-- create_decision_and_audit
-- If p_supersedes_decision_id is provided, atomically marks that decision as
-- 'superseded' in the same transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_decision_and_audit(
  p_title                  text,
  p_decision_text          text,
  p_rationale              text,
  p_owner_user_id          uuid,
  p_project_id             uuid,
  p_decided_at             timestamptz,
  p_status                 decision_status,
  p_supersedes_decision_id uuid,
  p_actor_user_id          uuid
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
    project_id, decided_at, status, supersedes_decision_id
  ) VALUES (
    p_title, p_decision_text, p_rationale, p_owner_user_id,
    p_project_id, p_decided_at, p_status, p_supersedes_decision_id
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

REVOKE EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_decision_and_audit(text, text, text, uuid, uuid, timestamptz, decision_status, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_decision_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_decision_and_audit(
  p_decision_id   uuid,
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
  UPDATE decisions SET
    title         = CASE WHEN p_patch ? 'title'         THEN  p_patch->>'title'                       ELSE title         END,
    decision_text = CASE WHEN p_patch ? 'decision_text' THEN  p_patch->>'decision_text'               ELSE decision_text END,
    rationale     = CASE WHEN p_patch ? 'rationale'     THEN  p_patch->>'rationale'                   ELSE rationale     END,
    project_id    = CASE WHEN p_patch ? 'project_id'    THEN (p_patch->>'project_id')::uuid           ELSE project_id    END,
    decided_at    = CASE WHEN p_patch ? 'decided_at'    THEN (p_patch->>'decided_at')::timestamptz    ELSE decided_at    END,
    status        = CASE WHEN p_patch ? 'status'        THEN (p_patch->>'status')::decision_status    ELSE status        END
  WHERE id = p_decision_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'decision.' || v_field || '.changed',
      'decision', p_decision_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_decision_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_decision_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- approve_decision_and_audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_decision_and_audit(
  p_decision_id        uuid,
  p_actor_user_id      uuid,
  p_approved_by_user_id uuid,
  p_before_status      decision_status
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE decisions
  SET status = 'approved', approved_by_user_id = p_approved_by_user_id
  WHERE id = p_decision_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'decision.approved', 'decision', p_decision_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'approved', 'approved_by_user_id', p_approved_by_user_id)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION approve_decision_and_audit(uuid, uuid, uuid, decision_status) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION approve_decision_and_audit(uuid, uuid, uuid, decision_status) TO service_role;
