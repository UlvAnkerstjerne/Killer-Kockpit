-- Killer Kockpit — M8 Brain: brain_excluded flag on kk_updates
--
-- PURPOSE:
--   Allow individual Updates to be permanently excluded from Kockpit Brain
--   retrieval.  Intended for QA/test records, seed data, and any Update that
--   should remain in the audit trail but must not influence AI answers.
--
--   This is a structured boolean flag, not keyword filtering.  Exclusion is
--   explicit and deliberate — never automatic based on content.
--
-- SEMANTICS:
--   brain_excluded = false (DEFAULT)  → included in Brain retrieval (all real Updates)
--   brain_excluded = true             → completely invisible to Brain queries
--
-- CORRECTION / SUPERSESSION:
--   correct_update RPC inserts a new row without specifying brain_excluded,
--   so it receives the column DEFAULT (false).  Corrected records are included
--   in Brain by default — correct and expected: a correction of a QA record
--   would itself be a real operational Update, and QA records should simply
--   not be corrected in the first place.
--
-- RLS IMPACT:
--   No change to RLS policies.  brain_excluded is a retrieval filter applied
--   inside the application and in the get_current_updates_for_entity RPC.

-- ── 1. Add column ─────────────────────────────────────────────────────────────

ALTER TABLE kk_updates
  ADD COLUMN IF NOT EXISTS brain_excluded boolean NOT NULL DEFAULT false;

-- ── 2. Mark existing QA / test records as excluded ────────────────────────────
--
-- These rows were created during M8 development to verify UI and RPC behaviour.
-- They are genuine kk_updates rows (not test fixtures) and must remain in the
-- table for audit continuity — but they must not appear in Brain answers.

UPDATE kk_updates
SET    brain_excluded = true
WHERE  id IN (
  '0d12ad56-d751-454c-aee5-129927cb80b7',  -- "Test update — project update UI QA"
  '1af6e5db-dae5-4eba-80de-a48529aa6265'   -- "M8 Universal Updates QA record..."
);

-- ── 3. Update get_current_updates_for_entity to honour brain_excluded ─────────
--
-- The RPC is SECURITY INVOKER and re-defined here in full (CREATE OR REPLACE).
-- The only change from migration 040 is:
--   AND NOT u.brain_excluded
-- added to the WHERE clause.

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
  IF p_entity_type NOT IN ('project', 'employee', 'location') THEN
    RAISE EXCEPTION 'Unsupported entity type: %', p_entity_type;
  END IF;

  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit must be a positive integer';
  END IF;

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
    AND NOT u.brain_excluded
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

REVOKE EXECUTE ON FUNCTION get_current_updates_for_entity(text, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_current_updates_for_entity(text, uuid, integer) FROM anon;
