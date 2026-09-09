-- 048_planday_sync_roster.sql
--
-- Planday P3: lightweight ongoing roster sync.
--
-- 1. Adds last_sync_at / last_sync_status / last_sync_error to planday_credentials.
-- 2. Creates planday_sync_roster SECURITY DEFINER RPC.
--
-- SECURITY MODEL:
--   SUPER_ADMIN callers (UI "Sync now"):
--     JWT present → get_my_app_user_id() returns user UUID → actor_type='app_user'
--   Cron / service_role callers:
--     No JWT → get_my_app_user_id() returns NULL → system call, actor_type='system'
--   Both are allowed. Only SUPER_ADMIN or system may run this.
--
-- WHAT IT UPDATES:
--   employees.name              — only when linked_user_id IS NULL and name differs
--   employees.employment_status — active ↔ left based on Planday source status;
--                                 'inactive' rows are never touched
--
-- WHAT IT NEVER TOUCHES:
--   birthday, started_on, role_title, manager, linked_user_id, locations, Updates.
--
-- ATOMICITY:
--   All UPDATE statements run in a single PostgreSQL transaction.
--   Audit INSERT is in a nested sub-transaction (failure does not roll back sync).
--
-- PORTAL VALIDATION:
--   p_portal_id is validated against planday_credentials.portal_id.
--   Prevents a misconfigured caller from updating against a wrong portal.

-- ── 1. Sync metadata columns ───────────────────────────────────────────────────

ALTER TABLE planday_credentials
  ADD COLUMN IF NOT EXISTS last_sync_at     timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_status text CHECK (last_sync_status IN ('success', 'error')),
  ADD COLUMN IF NOT EXISTS last_sync_error  text;

-- ── 2. planday_sync_roster RPC ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION planday_sync_roster(
  p_portal_id             text,
  p_active_employees      jsonb,   -- [{external_id, name}] — active in Planday
  p_deactivated_employees jsonb    -- [{external_id, name}] — deactivated in Planday
)
RETURNS jsonb
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id                    uuid;
  v_role                       kk_role;
  v_is_system                  boolean;
  v_stored_portal              text;
  v_emp                        jsonb;
  v_ext_id                     text;
  v_name                       text;
  v_employee_id                uuid;
  v_current_status             text;
  v_current_name               text;
  v_current_linked_user_id     uuid;
  v_mapped_processed           int := 0;
  v_names_updated              int := 0;
  v_activated                  int := 0;
  v_marked_left                int := 0;
  v_manual_inactive_preserved  int := 0;
  v_management_preserved       int := 0;
BEGIN
  -- ── 1. Auth gate ────────────────────────────────────────────────────────────
  v_user_id   := get_my_app_user_id();
  v_is_system := (v_user_id IS NULL);

  IF NOT v_is_system THEN
    v_role := get_my_role();
    IF v_role != 'SUPER_ADMIN' THEN
      RAISE EXCEPTION 'Not authorised: SUPER_ADMIN required for Planday roster sync';
    END IF;
  END IF;
  -- system calls (service_role / cron, no JWT) are always allowed

  -- ── 2. Validate portal_id ──────────────────────────────────────────────────
  SELECT portal_id INTO v_stored_portal
  FROM   planday_credentials
  WHERE  singleton_key = 'default';

  IF v_stored_portal IS NULL OR v_stored_portal != p_portal_id THEN
    RAISE EXCEPTION
      'Portal ID mismatch: supplied % does not match stored credentials (stored: %)',
      p_portal_id, v_stored_portal;
  END IF;

  -- ── 3. Process active employees (Planday status: active) ───────────────────
  --   Desired KK status: 'active'
  --   Name sync: only when linked_user_id IS NULL

  FOR v_emp IN SELECT * FROM jsonb_array_elements(p_active_employees)
  LOOP
    v_ext_id := v_emp->>'external_id';
    v_name   := trim(v_emp->>'name');

    SELECT
      e.id,
      e.employment_status,
      e.name,
      e.linked_user_id
    INTO
      v_employee_id,
      v_current_status,
      v_current_name,
      v_current_linked_user_id
    FROM employee_external_identities ei
    JOIN employees e ON e.id = ei.employee_id
    WHERE ei.provider       = 'planday'
      AND ei.external_scope = p_portal_id
      AND ei.external_id    = v_ext_id;

    IF NOT FOUND THEN
      CONTINUE;  -- unmapped — skip, do not auto-create
    END IF;

    v_mapped_processed := v_mapped_processed + 1;

    -- 'inactive' = manual override; never touch
    IF v_current_status = 'inactive' THEN
      v_manual_inactive_preserved := v_manual_inactive_preserved + 1;
      CONTINUE;
    END IF;

    -- Name sync
    IF v_current_linked_user_id IS NOT NULL THEN
      -- App user linked — preserve their name as managed by the linked user account
      v_management_preserved := v_management_preserved + 1;
    ELSIF v_name IS NOT NULL AND v_name != '' AND v_name != v_current_name THEN
      UPDATE employees SET name = v_name, updated_at = now() WHERE id = v_employee_id;
      v_names_updated := v_names_updated + 1;
    END IF;

    -- Status sync: if Planday says active but KK says left → reactivate
    IF v_current_status = 'left' THEN
      UPDATE employees SET employment_status = 'active', updated_at = now()
      WHERE id = v_employee_id;
      v_activated := v_activated + 1;
    END IF;
    -- (already 'active' → nothing to do)
  END LOOP;

  -- ── 4. Process deactivated employees (Planday status: deactivated) ─────────
  --   Desired KK status: 'left'
  --   Name sync: only when linked_user_id IS NULL

  FOR v_emp IN SELECT * FROM jsonb_array_elements(p_deactivated_employees)
  LOOP
    v_ext_id := v_emp->>'external_id';
    v_name   := trim(v_emp->>'name');

    SELECT
      e.id,
      e.employment_status,
      e.name,
      e.linked_user_id
    INTO
      v_employee_id,
      v_current_status,
      v_current_name,
      v_current_linked_user_id
    FROM employee_external_identities ei
    JOIN employees e ON e.id = ei.employee_id
    WHERE ei.provider       = 'planday'
      AND ei.external_scope = p_portal_id
      AND ei.external_id    = v_ext_id;

    IF NOT FOUND THEN
      CONTINUE;  -- unmapped — skip
    END IF;

    v_mapped_processed := v_mapped_processed + 1;

    -- 'inactive' = manual override; never touch
    IF v_current_status = 'inactive' THEN
      v_manual_inactive_preserved := v_manual_inactive_preserved + 1;
      CONTINUE;
    END IF;

    -- Name sync
    IF v_current_linked_user_id IS NOT NULL THEN
      v_management_preserved := v_management_preserved + 1;
    ELSIF v_name IS NOT NULL AND v_name != '' AND v_name != v_current_name THEN
      UPDATE employees SET name = v_name, updated_at = now() WHERE id = v_employee_id;
      v_names_updated := v_names_updated + 1;
    END IF;

    -- Status sync: if Planday says deactivated but KK says active → mark left
    IF v_current_status = 'active' THEN
      UPDATE employees SET employment_status = 'left', updated_at = now()
      WHERE id = v_employee_id;
      v_marked_left := v_marked_left + 1;
    END IF;
    -- (already 'left' → nothing to do)
  END LOOP;

  -- ── 5. Summary audit event (failure does not roll back the sync) ───────────
  BEGIN
    INSERT INTO audit_events (
      actor_user_id,
      actor_type,
      action,
      entity_type,
      entity_id,
      after_json
    ) VALUES (
      v_user_id,
      CASE WHEN v_is_system THEN 'system' ELSE 'app_user' END,
      'planday.roster_sync',
      'planday_sync',
      p_portal_id,
      jsonb_build_object(
        'portal_id',                 p_portal_id,
        'mapped_processed',          v_mapped_processed,
        'names_updated',             v_names_updated,
        'activated',                 v_activated,
        'marked_left',               v_marked_left,
        'manual_inactive_preserved', v_manual_inactive_preserved,
        'management_preserved',      v_management_preserved
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- audit failure must not roll back the sync
  END;

  RETURN jsonb_build_object(
    'mapped_processed',          v_mapped_processed,
    'names_updated',             v_names_updated,
    'activated',                 v_activated,
    'marked_left',               v_marked_left,
    'manual_inactive_preserved', v_manual_inactive_preserved,
    'management_preserved',      v_management_preserved
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION planday_sync_roster(text, jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION planday_sync_roster(text, jsonb, jsonb) FROM anon;
-- authenticated and service_role retain execute per Supabase defaults
