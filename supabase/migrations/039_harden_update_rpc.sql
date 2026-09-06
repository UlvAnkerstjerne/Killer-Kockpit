-- Killer Kockpit — M8A3b: harden create_update_and_links author identity
--
-- PROBLEM WITH 038:
--   The original RPC accepted p_created_by_user_id from the caller.
--   Even though the server action passes getCurrentUser().id, a privileged
--   caller (service_role) could theoretically manufacture any author identity.
--
-- FIX:
--   1. DROP the old 4-param signature (text, date, uuid, jsonb).
--      In PostgreSQL a FUNCTION is identified by its parameter types,
--      so CREATE OR REPLACE with a different param list creates a NEW
--      overload rather than replacing the old one.  We must DROP explicitly.
--
--   2. CREATE new 3-param signature (text, date, jsonb).
--      Inside the function, derive the caller's identity and role using
--      the existing session-bound helpers:
--
--          v_user_id := get_my_app_user_id()   -- auth.uid() → app_users.id
--          v_role    := get_my_role()           -- app_users.role
--
--      Both helpers are SECURITY DEFINER and read app_users regardless of
--      the session role.  auth.uid() is a session variable (set from the
--      JWT by PostgREST) — it is NOT affected by SECURITY DEFINER, so it
--      correctly reflects the calling user even inside our SECURITY DEFINER
--      function.
--
-- EXECUTE GRANTS:
--   Supabase auto-grants EXECUTE to anon AND authenticated on every function
--   created in the public schema.
--
--   We REVOKE FROM anon  — unauthenticated callers must be blocked.
--   We KEEP authenticated — the server action uses createClient() (JWT session).
--   service_role has no JWT context; get_my_app_user_id() returns NULL and
--   the function raises "Not authenticated" — blocked by the function itself.
--
-- CALL SITE:
--   lib/actions/updates.ts now calls this RPC via createClient() (the SSR
--   cookie-session client), NOT createServiceClient().  The user's JWT is
--   included in the PostgREST request, so auth.uid() resolves correctly.
--
-- DOUBLE GATE:
--   Application layer: getCurrentUser() + canAccessManagementView() in
--     the TypeScript server action.
--   Database layer: get_my_app_user_id() IS NOT NULL + role IN ('SUPER_ADMIN','UM')
--     inside this function.
--   Both must pass; a bypass of one is caught by the other.

-- ── 1. Drop the old 4-param signature ─────────────────────────────────────────
DROP FUNCTION IF EXISTS create_update_and_links(text, date, uuid, jsonb);

-- ── 2. Create the hardened 3-param signature ──────────────────────────────────

CREATE OR REPLACE FUNCTION create_update_and_links(
  p_body         text,
  p_occurred_on  date,
  p_entity_links jsonb   -- [{entity_type: text, entity_id: uuid}, …]
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id uuid;
  v_role    kk_role;
  v_id      uuid;
  v_link    record;
  v_exists  boolean;
BEGIN
  -- ── Identity + role gate (both must pass) ────────────────────────────────
  v_user_id := get_my_app_user_id();
  v_role    := get_my_role();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_role NOT IN ('SUPER_ADMIN', 'UM') THEN
    RAISE EXCEPTION 'Not authorised: role % cannot create Updates', v_role;
  END IF;

  -- ── Body validation ───────────────────────────────────────────────────────
  IF trim(p_body) = '' THEN
    RAISE EXCEPTION 'Update body must not be blank';
  END IF;

  -- ── At least one entity link ──────────────────────────────────────────────
  IF p_entity_links IS NULL OR jsonb_array_length(p_entity_links) = 0 THEN
    RAISE EXCEPTION 'At least one entity link is required';
  END IF;

  -- ── Validate each link (type + existence) ─────────────────────────────────
  FOR v_link IN
    SELECT x.entity_type, x.entity_id
    FROM jsonb_to_recordset(p_entity_links)
      AS x(entity_type text, entity_id uuid)
  LOOP
    IF v_link.entity_type NOT IN ('project', 'employee', 'location') THEN
      RAISE EXCEPTION 'Unsupported entity type: %', v_link.entity_type;
    END IF;

    v_exists := false;
    CASE v_link.entity_type
      WHEN 'project'  THEN SELECT EXISTS (SELECT 1 FROM projects  WHERE id = v_link.entity_id) INTO v_exists;
      WHEN 'employee' THEN SELECT EXISTS (SELECT 1 FROM employees WHERE id = v_link.entity_id) INTO v_exists;
      WHEN 'location' THEN SELECT EXISTS (SELECT 1 FROM locations WHERE id = v_link.entity_id) INTO v_exists;
    END CASE;

    IF NOT v_exists THEN
      RAISE EXCEPTION '% not found: %', v_link.entity_type, v_link.entity_id;
    END IF;
  END LOOP;

  -- ── Insert the update record (author = derived session user) ──────────────
  -- supersedes_update_id is NULL — creation path only; correction deferred.
  INSERT INTO kk_updates (body, created_by_user_id, occurred_on)
  VALUES (p_body, v_user_id, p_occurred_on)
  RETURNING id INTO v_id;

  -- ── Insert entity links (ON CONFLICT DO NOTHING deduplicates) ────────────
  INSERT INTO kk_update_entities (update_id, entity_type, entity_id)
  SELECT v_id, (link->>'entity_type'), (link->>'entity_id')::uuid
  FROM jsonb_array_elements(p_entity_links) AS link
  ON CONFLICT DO NOTHING;

  -- ── Audit event (actor = same derived session user) ───────────────────────
  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    v_user_id,
    'human',
    'update.created',
    'update',
    v_id,
    jsonb_build_object(
      'body_length',       length(p_body),
      'entity_link_count', jsonb_array_length(p_entity_links),
      'occurred_on',       p_occurred_on
    )
  );

  RETURN v_id;
END;
$$;

-- ── 3. Execute permissions ────────────────────────────────────────────────────
-- Supabase auto-grants to anon and authenticated.
-- Remove anon; keep authenticated (our call site uses the JWT-session client).
-- service_role has no JWT → auth.uid() = NULL → blocked by the identity check.

REVOKE EXECUTE ON FUNCTION create_update_and_links(text, date, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_update_and_links(text, date, jsonb) FROM anon;
-- authenticated retains the Supabase auto-grant (no explicit GRANT needed)
