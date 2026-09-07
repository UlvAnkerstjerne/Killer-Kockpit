-- Killer Kockpit — M8C2: correct_update RPC (append-only supersession)
--
-- PURPOSE:
--   Allow a management user to correct a CURRENT Universal Update by creating
--   an immutable successor row that supersedes the original.  The original row
--   is never modified or deleted — it remains the historical record.
--
-- CORRECTION SEMANTICS:
--   old Update  → immutable historical record (supersedes_update_id IS NULL there)
--   new Update  → new kk_updates row with supersedes_update_id = old.id
--   The new row inherits ALL entity links from the old row.
--   Correction chains (A → B → C) are supported; only the head is "current".
--
-- SECURITY MODEL (identical to create_update_and_links):
--   SECURITY DEFINER  — runs as owner, allowing the INSERT into kk_updates and
--                        audit_events which have no direct-write RLS policies.
--   SET search_path   — prevents search-path injection.
--   Author identity and role are derived INSIDE the function from the caller's
--   JWT session — never accepted as caller arguments.
--   REVOKE from PUBLIC and anon; authenticated retains Supabase auto-grant.
--   service_role has no JWT → get_my_app_user_id() returns NULL → blocked.
--
-- CONCURRENCY / CURRENTNESS:
--   SELECT … FOR UPDATE locks the target row within the transaction.
--   The successor existence check runs AFTER the lock is acquired, so two
--   concurrent corrections of the same Update cannot both succeed.
--   The UNIQUE constraint on kk_updates.supersedes_update_id is defence in depth:
--   even if the lock failed to prevent a race, only one INSERT can commit.
--
-- ATOMICITY:
--   A single PostgreSQL transaction covers:
--     1. auth / role gate
--     2. body validation
--     3. target lock + currentness check
--     4. entity-link count guard
--     5. INSERT kk_updates (successor)
--     6. INSERT kk_update_entities (copied links)
--     7. INSERT audit_events
--   Any failure rolls everything back.  No partial state is possible.

CREATE OR REPLACE FUNCTION correct_update(
  p_update_id   uuid,
  p_body        text,
  p_occurred_on date      -- nullable; null means "no date recorded"
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id    uuid;
  v_role       kk_role;
  v_new_id     uuid;
  v_link_count integer;
BEGIN
  -- ── 1. Identity + role gate (both must pass) ─────────────────────────────
  v_user_id := get_my_app_user_id();
  v_role    := get_my_role();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_role NOT IN ('SUPER_ADMIN', 'UM') THEN
    RAISE EXCEPTION 'Not authorised: role % cannot correct Updates', v_role;
  END IF;

  -- ── 2. Body validation ───────────────────────────────────────────────────
  IF p_body IS NULL OR trim(p_body) = '' THEN
    RAISE EXCEPTION 'Corrected body must not be blank';
  END IF;

  -- ── 3. Lock target row + verify it exists ────────────────────────────────
  -- FOR UPDATE acquires a row-level lock within this transaction, preventing
  -- a concurrent correction from passing the currentness check below until
  -- this transaction commits or rolls back.
  PERFORM id
  FROM    kk_updates
  WHERE   id = p_update_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Update not found: %', p_update_id;
  END IF;

  -- ── 4. Verify target is current (no existing successor) ──────────────────
  -- Evaluated AFTER the FOR UPDATE lock — safe against concurrent corrections.
  IF EXISTS (
    SELECT 1
    FROM   kk_updates
    WHERE  supersedes_update_id = p_update_id
  ) THEN
    RAISE EXCEPTION 'Update has already been corrected';
  END IF;

  -- ── 5. Verify target has at least one entity link ────────────────────────
  SELECT COUNT(*)
  INTO   v_link_count
  FROM   kk_update_entities
  WHERE  update_id = p_update_id;

  IF v_link_count = 0 THEN
    RAISE EXCEPTION 'Target update has no entity links and cannot be corrected';
  END IF;

  -- ── 6. Insert successor row ──────────────────────────────────────────────
  -- Author = current authenticated session user (never caller-supplied).
  -- supersedes_update_id = old Update id → marks old as no longer current.
  INSERT INTO kk_updates (body, created_by_user_id, occurred_on, supersedes_update_id)
  VALUES (trim(p_body), v_user_id, p_occurred_on, p_update_id)
  RETURNING id INTO v_new_id;

  -- ── 7. Copy ALL entity links from old → new ──────────────────────────────
  -- The successor inherits exactly the same canonical subjects.
  -- Entity-link editing during correction is deferred to a later slice.
  INSERT INTO kk_update_entities (update_id, entity_type, entity_id)
  SELECT v_new_id, entity_type, entity_id
  FROM   kk_update_entities
  WHERE  update_id = p_update_id;

  -- ── 8. Audit event (same transaction) ────────────────────────────────────
  -- Body text intentionally excluded — it is preserved in kk_updates.body.
  -- Safe metadata only: IDs, counts, occurred_on.
  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    v_user_id,
    'human',
    'update.corrected',
    'update',
    v_new_id,
    jsonb_build_object(
      'superseded_update_id', p_update_id,
      'new_update_id',        v_new_id,
      'body_length',          length(trim(p_body)),
      'occurred_on',          p_occurred_on,
      'entity_link_count',    v_link_count
    )
  );

  RETURN v_new_id;
END;
$$;

-- ── Execute permissions ───────────────────────────────────────────────────────
-- Supabase auto-grants EXECUTE to anon and authenticated on all public functions.
-- Remove anon; authenticated retains the auto-grant (call site uses createClient).
-- service_role has no JWT → auth.uid() = NULL → blocked by identity check above.

REVOKE EXECUTE ON FUNCTION correct_update(uuid, text, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION correct_update(uuid, text, date) FROM anon;
-- authenticated: retains Supabase auto-grant
