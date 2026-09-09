-- 049_planday_sync_roster_audit_fix.sql
--
-- Fix: planday_sync_roster audit INSERT passed p_portal_id (text like '175790')
-- as entity_id, but audit_events.entity_id is typed uuid.  This caused a silent
-- error caught by EXCEPTION WHEN OTHERS THEN NULL, so no audit event was written.
--
-- Fix: remove entity_id from the INSERT (leave it NULL).
-- portal_id is already present in after_json, so no information is lost.
-- All other function logic is unchanged.

CREATE OR REPLACE FUNCTION planday_sync_roster(
  p_portal_id             text,
  p_active_employees      jsonb,
  p_deactivated_employees jsonb
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
  v_user_id   := get_my_app_user_id();
  v_is_system := (v_user_id IS NULL);

  IF NOT v_is_system THEN
    v_role := get_my_role();
    IF v_role != 'SUPER_ADMIN' THEN
      RAISE EXCEPTION 'Not authorised: SUPER_ADMIN required for Planday roster sync';
    END IF;
  END IF;

  SELECT portal_id INTO v_stored_portal
  FROM   planday_credentials
  WHERE  singleton_key = 'default';

  IF v_stored_portal IS NULL OR v_stored_portal != p_portal_id THEN
    RAISE EXCEPTION
      'Portal ID mismatch: supplied % does not match stored credentials (stored: %)',
      p_portal_id, v_stored_portal;
  END IF;

  FOR v_emp IN SELECT * FROM jsonb_array_elements(p_active_employees)
  LOOP
    v_ext_id := v_emp->>'external_id';
    v_name   := trim(v_emp->>'name');

    SELECT e.id, e.employment_status, e.name, e.linked_user_id
    INTO   v_employee_id, v_current_status, v_current_name, v_current_linked_user_id
    FROM employee_external_identities ei
    JOIN employees e ON e.id = ei.employee_id
    WHERE ei.provider = 'planday' AND ei.external_scope = p_portal_id AND ei.external_id = v_ext_id;

    IF NOT FOUND THEN CONTINUE; END IF;
    v_mapped_processed := v_mapped_processed + 1;

    IF v_current_status = 'inactive' THEN
      v_manual_inactive_preserved := v_manual_inactive_preserved + 1;
      CONTINUE;
    END IF;

    IF v_current_linked_user_id IS NOT NULL THEN
      v_management_preserved := v_management_preserved + 1;
    ELSIF v_name IS NOT NULL AND v_name != '' AND v_name != v_current_name THEN
      UPDATE employees SET name = v_name, updated_at = now() WHERE id = v_employee_id;
      v_names_updated := v_names_updated + 1;
    END IF;

    IF v_current_status = 'left' THEN
      UPDATE employees SET employment_status = 'active', updated_at = now() WHERE id = v_employee_id;
      v_activated := v_activated + 1;
    END IF;
  END LOOP;

  FOR v_emp IN SELECT * FROM jsonb_array_elements(p_deactivated_employees)
  LOOP
    v_ext_id := v_emp->>'external_id';
    v_name   := trim(v_emp->>'name');

    SELECT e.id, e.employment_status, e.name, e.linked_user_id
    INTO   v_employee_id, v_current_status, v_current_name, v_current_linked_user_id
    FROM employee_external_identities ei
    JOIN employees e ON e.id = ei.employee_id
    WHERE ei.provider = 'planday' AND ei.external_scope = p_portal_id AND ei.external_id = v_ext_id;

    IF NOT FOUND THEN CONTINUE; END IF;
    v_mapped_processed := v_mapped_processed + 1;

    IF v_current_status = 'inactive' THEN
      v_manual_inactive_preserved := v_manual_inactive_preserved + 1;
      CONTINUE;
    END IF;

    IF v_current_linked_user_id IS NOT NULL THEN
      v_management_preserved := v_management_preserved + 1;
    ELSIF v_name IS NOT NULL AND v_name != '' AND v_name != v_current_name THEN
      UPDATE employees SET name = v_name, updated_at = now() WHERE id = v_employee_id;
      v_names_updated := v_names_updated + 1;
    END IF;

    IF v_current_status = 'active' THEN
      UPDATE employees SET employment_status = 'left', updated_at = now() WHERE id = v_employee_id;
      v_marked_left := v_marked_left + 1;
    END IF;
  END LOOP;

  -- Audit: entity_id omitted (portal IDs are not UUIDs; portal_id is in after_json)
  BEGIN
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, after_json)
    VALUES (
      v_user_id,
      CASE WHEN v_is_system THEN 'system' ELSE 'app_user' END,
      'planday.roster_sync',
      'planday_sync',
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
    NULL;
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
