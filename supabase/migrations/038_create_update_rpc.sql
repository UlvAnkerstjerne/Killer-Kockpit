-- Killer Kockpit — M8A3: create_update_and_links RPC
--
-- Transactional stored procedure that atomically:
--   1. Validates body (non-blank)
--   2. Validates ≥1 entity link supplied
--   3. Validates each entity_type is in the allowed set
--   4. Validates each entity_id exists in its canonical table
--   5. Inserts the kk_updates row
--   6. Inserts all kk_update_entities rows (ON CONFLICT DO NOTHING deduplicates)
--   7. Inserts an audit_events row
--
-- If any step raises an exception, the PostgreSQL transaction rolls back and
-- no kk_updates or kk_update_entities rows are persisted.
--
-- Security model (identical to all other institutional mutation RPCs):
--   SECURITY DEFINER    — runs as owner (postgres), bypassing RLS so that
--                         audit_events can be written regardless of caller role
--   SET search_path     — prevents search-path injection
--   REVOKE … FROM PUBLIC, anon, authenticated
--   GRANT  … TO service_role
--
-- The application-layer server action (lib/actions/updates.ts) is the only
-- permitted caller.  It authenticates the user, enforces the role gate, and
-- supplies p_created_by_user_id from getCurrentUser().id — never from browser
-- input.

CREATE OR REPLACE FUNCTION create_update_and_links(
  p_body               text,
  p_occurred_on        date,
  p_created_by_user_id uuid,
  p_entity_links       jsonb   -- [{entity_type: text, entity_id: uuid}, …]
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id      uuid;
  v_link    record;
  v_exists  boolean;
BEGIN
  -- ── 1. Validate body ──────────────────────────────────────────────────────
  IF trim(p_body) = '' THEN
    RAISE EXCEPTION 'Update body must not be blank';
  END IF;

  -- ── 2. Validate at least one entity link ──────────────────────────────────
  IF p_entity_links IS NULL OR jsonb_array_length(p_entity_links) = 0 THEN
    RAISE EXCEPTION 'At least one entity link is required';
  END IF;

  -- ── 3 & 4. Validate each link (type + existence) ──────────────────────────
  FOR v_link IN
    SELECT
      x.entity_type,
      x.entity_id
    FROM jsonb_to_recordset(p_entity_links)
      AS x(entity_type text, entity_id uuid)
  LOOP
    -- Reject unsupported entity types
    IF v_link.entity_type NOT IN ('project', 'employee', 'location') THEN
      RAISE EXCEPTION 'Unsupported entity type: %', v_link.entity_type;
    END IF;

    -- Verify entity exists in its canonical table
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

  -- ── 5. Insert the update record ───────────────────────────────────────────
  -- supersedes_update_id is NULL — creation path only, correction deferred.
  INSERT INTO kk_updates (body, created_by_user_id, occurred_on)
  VALUES (p_body, p_created_by_user_id, p_occurred_on)
  RETURNING id INTO v_id;

  -- ── 6. Insert entity links (deduplication via ON CONFLICT DO NOTHING) ─────
  INSERT INTO kk_update_entities (update_id, entity_type, entity_id)
  SELECT
    v_id,
    (link->>'entity_type'),
    (link->>'entity_id')::uuid
  FROM jsonb_array_elements(p_entity_links) AS link
  ON CONFLICT DO NOTHING;

  -- ── 7. Audit event ────────────────────────────────────────────────────────
  -- Body text is intentionally excluded from the audit record — it is
  -- preserved immutably in kk_updates.body and need not be duplicated here.
  INSERT INTO audit_events (
    actor_user_id,
    actor_type,
    action,
    entity_type,
    entity_id,
    after_json
  )
  VALUES (
    p_created_by_user_id,
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

-- ── Permissions ───────────────────────────────────────────────────────────────
-- Supabase automatically grants EXECUTE to anon and authenticated on any
-- function created in the public schema.  Revoke both explicitly.

REVOKE EXECUTE ON FUNCTION create_update_and_links(text, date, uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_update_and_links(text, date, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION create_update_and_links(text, date, uuid, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION create_update_and_links(text, date, uuid, jsonb) TO service_role;
