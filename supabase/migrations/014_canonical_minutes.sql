-- Migration 014: M5D — Canonical Published Minutes
--
-- Two changes:
--
--   1. RLS: Grant MEMBER read access to meeting_minutes for meetings they own
--      or attended. Mirrors the existing meeting visibility policies (migration
--      006) and the meeting_corrections policies (migration 008).
--
--   2. publish_meeting_and_audit: Atomically inserts the canonical
--      meeting_minutes row within the same transaction as outcome publication
--      and meeting status transition.
--
-- meeting_minutes schema (migration 001, unchanged):
--   id                  uuid PK
--   meeting_id          uuid NOT NULL FK meetings(id)
--   version             integer NOT NULL DEFAULT 1
--   body                text NOT NULL
--   status              text NOT NULL DEFAULT 'draft'
--   approved_by_user_id uuid FK app_users(id)
--   approved_at         timestamptz
--   created_at          timestamptz NOT NULL DEFAULT now()
--   UNIQUE (meeting_id, version)
--
-- No schema changes to meetings or meeting_minutes tables.
-- The function signature publish_meeting_and_audit(uuid, uuid) is unchanged.

-- ---------------------------------------------------------------------------
-- 1. RLS — meeting_minutes: grant MEMBER read for owned/attended meetings
-- ---------------------------------------------------------------------------

CREATE POLICY "meeting_minutes: member can read attended"
  ON meeting_minutes FOR SELECT TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND meeting_id IN (
      SELECT id FROM meetings
      WHERE owner_user_id = get_my_app_user_id()
         OR id IN (
           SELECT meeting_id FROM meeting_attendees
           WHERE user_id = get_my_app_user_id()
         )
    )
  );

-- ---------------------------------------------------------------------------
-- 2. publish_meeting_and_audit — add canonical minutes snapshot
--
-- Preserved exactly from migration 006:
--   • Signature: (p_meeting_id uuid, p_actor_user_id uuid)
--   • FOR UPDATE lock on the meetings row → status must be 'draft'
--   • Outcome processing loop (task / waiting_on / decision)
--   • meeting.status = 'published', minutes_status = 'published'
--   • meeting.published audit event
--   • All logic within a single implicit transaction (PL/pgSQL)
--
-- New:
--   • SELECT working_notes INTO v_working_notes replaces bare PERFORM
--     (same lock, same guard, captures notes for the snapshot)
--   • INSERT meeting_minutes after outcomes, before meeting status flip
--   • body is NOT NULL → COALESCE(v_working_notes, '') stores '' for empty notes
--   • ON CONFLICT (meeting_id, version) DO NOTHING: belt-and-suspenders guard.
--     The primary protection is the status='draft' guard: once the meeting is
--     'published' a second call raises EXCEPTION before reaching the INSERT.
--
-- Atomicity: all INSERTs/UPDATEs are in the same PL/pgSQL transaction.
-- If any statement fails the entire transaction rolls back — no partial state.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION publish_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_outcome        RECORD;
  v_entity_id      uuid;
  v_entity_count   integer := 0;
  v_working_notes  text;
BEGIN
  -- Lock meeting row; capture working_notes for the minutes snapshot.
  -- RAISE if not in draft — primary idempotency guard against double-publish.
  SELECT working_notes INTO v_working_notes
  FROM meetings
  WHERE id = p_meeting_id AND status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meeting % is not in draft status', p_meeting_id;
  END IF;

  -- ── Process proposed outcomes in order ────────────────────────────────────
  FOR v_outcome IN
    SELECT * FROM meeting_outcomes
    WHERE meeting_id = p_meeting_id AND status = 'proposed'
    ORDER BY sort_order, created_at
  LOOP
    v_entity_id := NULL;

    IF v_outcome.kind = 'task' THEN
      INSERT INTO tasks (
        title, owner_user_id, project_id, priority,
        due_at, description, meeting_id, created_by_user_id, status
      ) VALUES (
        v_outcome.title,
        (v_outcome.payload_json->>'owner_user_id')::uuid,
        (v_outcome.payload_json->>'project_id')::uuid,
        COALESCE((v_outcome.payload_json->>'priority')::smallint, 2),
        (v_outcome.payload_json->>'due_at')::timestamptz,
        v_outcome.payload_json->>'description',
        p_meeting_id,
        p_actor_user_id,
        'open'
      ) RETURNING id INTO v_entity_id;

      INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
      VALUES (p_actor_user_id, 'human', 'task.created', 'task', v_entity_id,
        jsonb_build_object('title', v_outcome.title, 'status', 'open',
                           'via_meeting', p_meeting_id));

    ELSIF v_outcome.kind = 'waiting_on' THEN
      INSERT INTO waiting_ons (
        title, owner_user_id, waiting_for_user_id, waiting_for_name,
        project_id, due_at, notes, meeting_id, status
      ) VALUES (
        v_outcome.title,
        (v_outcome.payload_json->>'owner_user_id')::uuid,
        (v_outcome.payload_json->>'waiting_for_user_id')::uuid,
        v_outcome.payload_json->>'waiting_for_name',
        (v_outcome.payload_json->>'project_id')::uuid,
        (v_outcome.payload_json->>'due_at')::timestamptz,
        v_outcome.payload_json->>'notes',
        p_meeting_id,
        'open'
      ) RETURNING id INTO v_entity_id;

      INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
      VALUES (p_actor_user_id, 'human', 'waiting_on.created', 'waiting_on', v_entity_id,
        jsonb_build_object('title', v_outcome.title, 'status', 'open',
                           'via_meeting', p_meeting_id));

    ELSIF v_outcome.kind = 'decision' THEN
      INSERT INTO decisions (
        title, decision_text, rationale, owner_user_id,
        project_id, decided_at, meeting_id, status
      ) VALUES (
        v_outcome.title,
        COALESCE(v_outcome.payload_json->>'decision_text', ''),
        v_outcome.payload_json->>'rationale',
        (v_outcome.payload_json->>'owner_user_id')::uuid,
        (v_outcome.payload_json->>'project_id')::uuid,
        COALESCE((v_outcome.payload_json->>'decided_at')::timestamptz, now()),
        p_meeting_id,
        COALESCE(
          (v_outcome.payload_json->>'status')::decision_status,
          'approved'
        )
      ) RETURNING id INTO v_entity_id;

      INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
      VALUES (p_actor_user_id, 'human', 'decision.created', 'decision', v_entity_id,
        jsonb_build_object('title', v_outcome.title, 'via_meeting', p_meeting_id));
    END IF;

    -- Mark outcome as published
    UPDATE meeting_outcomes
    SET status = 'published', published_entity_id = v_entity_id
    WHERE id = v_outcome.id;

    v_entity_count := v_entity_count + 1;
  END LOOP;

  -- ── Create canonical minutes snapshot ─────────────────────────────────────
  -- body is NOT NULL in the schema; COALESCE converts null notes to ''.
  -- ON CONFLICT DO NOTHING: secondary guard for edge-case retries.
  -- The primary guard (status='draft' check above) prevents a true re-publish.
  INSERT INTO meeting_minutes (
    meeting_id, version, body, status, approved_by_user_id, approved_at
  ) VALUES (
    p_meeting_id,
    1,
    COALESCE(v_working_notes, ''),
    'published',
    p_actor_user_id,
    now()
  )
  ON CONFLICT (meeting_id, version) DO NOTHING;

  -- ── Mark meeting as published ──────────────────────────────────────────────
  UPDATE meetings
  SET status = 'published', minutes_status = 'published'
  WHERE id = p_meeting_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.published', 'meeting', p_meeting_id,
    jsonb_build_object('status', 'published', 'entities_created', v_entity_count)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION publish_meeting_and_audit(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION publish_meeting_and_audit(uuid, uuid) TO service_role;
