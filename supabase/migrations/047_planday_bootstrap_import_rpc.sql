-- 047_planday_bootstrap_import_rpc.sql
--
-- SECURITY MODEL (identical pattern to correct_update):
--   SECURITY DEFINER  — runs as owner, allowing writes to employees and
--                        employee_external_identities (RLS-protected tables).
--   SET search_path   — prevents search-path injection.
--   Actor identity and role derived INSIDE the function from the caller's
--   JWT session via get_my_app_user_id() / get_my_role() — never accepted
--   as caller arguments. service_role has no JWT → blocked.
--   REVOKE from PUBLIC and anon; authenticated retains Supabase auto-grant.
--
-- ATOMICITY:
--   All employee INSERTs, identity INSERTs, and fill-null UPDATEs occur in
--   a single PostgreSQL transaction.  Any failure rolls the entire batch back.
--   No partial roster state is possible.
--
-- IDEMPOTENCY:
--   The (provider, external_scope, external_id) UNIQUE constraint on
--   employee_external_identities is the authoritative deduplication guard.
--   Any external_id already linked in the DB is treated as "already done"
--   and counted toward v_linked — never results in a duplicate employee.
--
-- SECURITY RESTRICTIONS:
--   provider is hard-coded to 'planday' inside the function.
--   portal_id is validated against the stored planday_credentials row.
--   The client (browser) may only supply: external_id, action, employee_id.
--   All sensitive fields (name, employment_status, birthday, started_on) are
--   supplied by the server-side action after re-fetching from Planday — this
--   function trusts the server, not the browser.

CREATE OR REPLACE FUNCTION planday_bootstrap_import(
  p_portal_id  text,
  p_decisions  jsonb   -- array of server-verified decision objects
)
RETURNS jsonb
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id       uuid;
  v_role          kk_role;
  v_stored_portal text;
  v_decision      jsonb;
  v_action        text;
  v_ext_id        text;
  v_emp_id        uuid;
  v_new_emp_id    uuid;
  v_created       int := 0;
  v_linked        int := 0;
  v_skipped       int := 0;
  v_active_new    int := 0;
  v_former_new    int := 0;
BEGIN
  -- ── 1. Identity + role gate ───────────────────────────────────────────────
  v_user_id := get_my_app_user_id();
  v_role    := get_my_role();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_role != 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Not authorised: SUPER_ADMIN required for Planday bootstrap import';
  END IF;

  -- ── 2. Validate portal_id against stored credentials ─────────────────────
  -- Prevents a manipulated client from importing against an arbitrary portal.
  SELECT portal_id INTO v_stored_portal
  FROM   planday_credentials
  WHERE  singleton_key = 'default';

  IF v_stored_portal IS NULL OR v_stored_portal != p_portal_id THEN
    RAISE EXCEPTION
      'Portal ID mismatch: supplied % does not match stored credentials (stored: %)',
      p_portal_id, v_stored_portal;
  END IF;

  -- ── 3. Validate decisions is a non-empty array ────────────────────────────
  IF jsonb_typeof(p_decisions) != 'array' THEN
    RAISE EXCEPTION 'p_decisions must be a JSON array';
  END IF;

  -- ── 4. Process each decision atomically ──────────────────────────────────
  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_action := v_decision->>'action';
    v_ext_id := v_decision->>'external_id';

    -- Validate required fields
    IF v_ext_id IS NULL OR trim(v_ext_id) = '' THEN
      RAISE EXCEPTION 'Decision has empty external_id: %', v_decision;
    END IF;

    IF v_action NOT IN ('CREATE_NEW', 'LINK_EXISTING', 'SKIP') THEN
      RAISE EXCEPTION 'Invalid action % for external_id %', v_action, v_ext_id;
    END IF;

    -- Idempotency: check for existing identity mapping
    SELECT employee_id INTO v_emp_id
    FROM   employee_external_identities
    WHERE  provider       = 'planday'
      AND  external_scope = p_portal_id
      AND  external_id    = v_ext_id;

    IF FOUND THEN
      -- Already linked — idempotent; count toward linked
      v_linked := v_linked + 1;
      CONTINUE;
    END IF;

    -- ── SKIP ───────────────────────────────────────────────────────────────
    IF v_action = 'SKIP' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- ── CREATE_NEW ─────────────────────────────────────────────────────────
    IF v_action = 'CREATE_NEW' THEN
      -- All values here are server-verified (not browser-supplied).
      -- name and employment_status are required; birthday and started_on optional.
      INSERT INTO employees (
        name,
        employment_status,
        birthday_month,
        birthday_day,
        started_on,
        linked_user_id,
        manager_employee_id
      ) VALUES (
        trim(v_decision->>'name'),
        COALESCE(v_decision->>'employment_status', 'active'),
        -- birthday: JSON null → NULL; number → smallint
        CASE WHEN v_decision->'birthday_month' IS NOT NULL
                  AND v_decision->'birthday_month' != 'null'::jsonb
             THEN (v_decision->>'birthday_month')::smallint
             ELSE NULL
        END,
        CASE WHEN v_decision->'birthday_day' IS NOT NULL
                  AND v_decision->'birthday_day' != 'null'::jsonb
             THEN (v_decision->>'birthday_day')::smallint
             ELSE NULL
        END,
        CASE WHEN v_decision->>'started_on' IS NOT NULL
                  AND trim(v_decision->>'started_on') != ''
             THEN (v_decision->>'started_on')::date
             ELSE NULL
        END,
        NULL,   -- linked_user_id: never set by bootstrap
        NULL    -- manager_employee_id: never set by bootstrap
      )
      RETURNING id INTO v_new_emp_id;

      -- Create external identity mapping
      INSERT INTO employee_external_identities (employee_id, provider, external_scope, external_id)
      VALUES (v_new_emp_id, 'planday', p_portal_id, v_ext_id);

      v_created := v_created + 1;
      IF (v_decision->>'employment_status') = 'left' THEN
        v_former_new := v_former_new + 1;
      ELSE
        v_active_new := v_active_new + 1;
      END IF;
      CONTINUE;
    END IF;

    -- ── LINK_EXISTING ──────────────────────────────────────────────────────
    IF v_action = 'LINK_EXISTING' THEN
      BEGIN
        v_emp_id := (v_decision->>'employee_id')::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid employee_id for external_id %: %',
          v_ext_id, v_decision->>'employee_id';
      END;

      IF v_emp_id IS NULL THEN
        RAISE EXCEPTION 'LINK_EXISTING requires employee_id for external_id %', v_ext_id;
      END IF;

      -- Verify target employee exists
      IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_emp_id) THEN
        RAISE EXCEPTION 'Target employee % not found for external_id %', v_emp_id, v_ext_id;
      END IF;

      -- Insert identity mapping (ON CONFLICT = extra safety for idempotency)
      INSERT INTO employee_external_identities (employee_id, provider, external_scope, external_id)
      VALUES (v_emp_id, 'planday', p_portal_id, v_ext_id)
      ON CONFLICT (provider, external_scope, external_id) DO NOTHING;

      -- Fill null birthday if Planday provides a complete pair (existing Kockpit value wins)
      UPDATE employees SET
        birthday_month = (v_decision->>'offer_birthday_month')::smallint,
        birthday_day   = (v_decision->>'offer_birthday_day')::smallint
      WHERE id            = v_emp_id
        AND birthday_month IS NULL
        AND birthday_day   IS NULL
        AND v_decision->'offer_birthday_month' IS NOT NULL
        AND v_decision->'offer_birthday_month' != 'null'::jsonb
        AND v_decision->'offer_birthday_day'   IS NOT NULL
        AND v_decision->'offer_birthday_day'   != 'null'::jsonb;

      -- Fill null started_on if Planday provides one (existing Kockpit value wins)
      UPDATE employees SET
        started_on = (v_decision->>'offer_started_on')::date
      WHERE id         = v_emp_id
        AND started_on IS NULL
        AND v_decision->>'offer_started_on' IS NOT NULL
        AND trim(v_decision->>'offer_started_on') != '';

      v_linked := v_linked + 1;
      CONTINUE;
    END IF;

  END LOOP;

  -- ── 5. Audit event (non-blocking: failure must not roll back the import) ──
  BEGIN
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
    VALUES (
      v_user_id,
      'human',
      'planday.bootstrap_import',
      'planday_bootstrap',
      gen_random_uuid(),
      jsonb_build_object(
        'provider',    'planday',
        'portal_id',   p_portal_id,
        'created',     v_created,
        'linked',      v_linked,
        'skipped',     v_skipped,
        'active_new',  v_active_new,
        'former_new',  v_former_new
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- Audit failure must not roll back a successful import
    NULL;
  END;

  RETURN jsonb_build_object(
    'created',     v_created,
    'linked',      v_linked,
    'skipped',     v_skipped,
    'active_new',  v_active_new,
    'former_new',  v_former_new
  );
END;
$$;

-- ── Execute permissions ───────────────────────────────────────────────────────
-- service_role has no JWT → get_my_app_user_id() returns NULL → blocked.
-- authenticated role retains Supabase auto-grant (call site uses createClient).
REVOKE EXECUTE ON FUNCTION planday_bootstrap_import(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION planday_bootstrap_import(text, jsonb) FROM anon;
