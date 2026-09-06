-- Killer Kockpit — M8A4c: get_current_updates_for_entity read RPC
--
-- PURPOSE:
--   Return the top-N current (non-superseded) Update rows linked to one entity,
--   ordered correctly in PostgreSQL BEFORE the limit is applied.
--
--   The previous application approach (M8A4b) fetched all current update IDs in
--   three separate queries, then sorted and sliced in TypeScript.  That is
--   unbounded: if an entity accumulates thousands of Updates, all are fetched.
--
--   This function performs the ordering and limit inside the database, returning
--   at most p_limit (≤ 50) rows to the application.
--
-- SECURITY MODEL:
--   SECURITY INVOKER (PostgreSQL default) — the function runs as the calling
--   user, so the existing RLS policies on kk_updates and kk_update_entities
--   remain authoritative.  No privilege escalation is required for a read.
--
--   RLS policies (from 037_universal_updates.sql):
--     kk_updates:         SELECT allowed WHERE get_my_role() IN ('SUPER_ADMIN','UM')
--     kk_update_entities: SELECT allowed WHERE get_my_role() IN ('SUPER_ADMIN','UM')
--
--   A MEMBER calling this function will see zero rows — the RLS JOIN will
--   filter every row.  An anon caller is blocked via the REVOKE below.
--
-- CURRENTNESS:
--   An Update is current iff no successor row has supersedes_update_id = update.id.
--   This is expressed via NOT EXISTS — no mutable flag, no is_superseded column.
--
-- ORDERING (applied in DB before LIMIT):
--   COALESCE(occurred_on, created_at::date) DESC  — effective date
--   created_at DESC                               — tie-break
--
-- GRANTS:
--   Supabase auto-grants EXECUTE to anon and authenticated on all public functions.
--   We REVOKE from anon; authenticated retains the auto-grant.
--   MEMBER authenticated users are blocked by RLS, not by EXECUTE permissions.

CREATE OR REPLACE FUNCTION get_current_updates_for_entity(
  p_entity_type text,
  p_entity_id   uuid,
  p_limit       integer DEFAULT 50
)
RETURNS TABLE (
  id                   uuid,
  body                 text,
  occurred_on          date,
  created_at           timestamptz,
  created_by_user_id   uuid,
  supersedes_update_id uuid
)
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  -- ── Input validation ──────────────────────────────────────────────────────
  IF p_entity_type NOT IN ('project', 'employee', 'location') THEN
    RAISE EXCEPTION 'Unsupported entity type: %', p_entity_type;
  END IF;

  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit must be a positive integer';
  END IF;

  -- ── Core query: current Updates for entity, ordered, bounded ──────────────
  --
  -- COALESCE(u.occurred_on, u.created_at::date) produces the effective date:
  --   • occurred_on when non-null  (date-precision knowledge recorded by author)
  --   • created_at calendar date   (system timestamp used as fallback)
  --
  -- NOT EXISTS filters superseded Updates without a mutable flag:
  --   an Update is current iff no successor row points to it.
  --
  -- LEAST(p_limit, 50) enforces the hard cap even if a caller passes a large limit.

  RETURN QUERY
  SELECT
    u.id,
    u.body,
    u.occurred_on,
    u.created_at,
    u.created_by_user_id,
    u.supersedes_update_id
  FROM kk_update_entities ue
  JOIN kk_updates u ON u.id = ue.update_id
  WHERE ue.entity_type = p_entity_type
    AND ue.entity_id   = p_entity_id
    AND NOT EXISTS (
      SELECT 1
      FROM   kk_updates successor
      WHERE  successor.supersedes_update_id = u.id
    )
  ORDER BY
    COALESCE(u.occurred_on, u.created_at::date) DESC,
    u.created_at DESC
  LIMIT LEAST(p_limit, 50);
END;
$$;

-- ── Execute permissions ───────────────────────────────────────────────────────
-- Supabase auto-grants EXECUTE to anon and authenticated.
-- Remove anon; authenticated retains the grant (our call site uses createClient).
-- MEMBER users are blocked by RLS — they need no explicit REVOKE here.

REVOKE EXECUTE ON FUNCTION get_current_updates_for_entity(text, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_current_updates_for_entity(text, uuid, integer) FROM anon;
-- authenticated: retains Supabase auto-grant
