-- Killer Kockpit — Migration 013: Apply AI Draft (Phase M5C)
--
-- Scope:
--   1. Add meeting_outcomes.ai_draft_id — provenance link from outcome back to the
--      AI draft that proposed it. NULL for manually-added outcomes.
--   2. apply_meeting_ai_draft_and_audit() — atomic stored procedure that:
--        • Verifies the draft is available (not applied, not discarded, belongs to meeting)
--        • Verifies the meeting is in an editable status (scheduled/open/draft)
--        • Optionally updates working_notes with the draft's minutes
--        • Creates proposed meeting_outcomes with ai_draft_id set for provenance
--        • Marks the draft as applied (applied_at, applied_by_user_id)
--        • Inserts a meeting.ai_draft_applied audit event
--        • Rolls back on any error (LANGUAGE plpgsql — implicit transaction per call)

-- ─── 1. Add ai_draft_id to meeting_outcomes ──────────────────────────────────

ALTER TABLE meeting_outcomes
  ADD COLUMN IF NOT EXISTS ai_draft_id uuid REFERENCES meeting_ai_drafts(id);

-- ─── 2. apply_meeting_ai_draft_and_audit ─────────────────────────────────────

CREATE OR REPLACE FUNCTION apply_meeting_ai_draft_and_audit(
  p_draft_id      uuid,
  p_meeting_id    uuid,
  p_actor_user_id uuid,
  p_working_notes text,  -- NULL = do not overwrite; any string (including empty) = set working_notes
  p_outcomes      jsonb  -- array of {kind, title, payload_json, sort_order}
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_outcome  jsonb;
  v_count    integer := 0;
BEGIN
  -- Lock and verify draft: must belong to this meeting and be unapplied/undiscarded
  PERFORM 1 FROM meeting_ai_drafts
  WHERE id         = p_draft_id
    AND meeting_id = p_meeting_id
    AND applied_at   IS NULL
    AND discarded_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Draft % is not available to apply (not found, already applied, or discarded)',
      p_draft_id;
  END IF;

  -- Lock and verify meeting: must be in an editable status
  PERFORM 1 FROM meetings
  WHERE id     = p_meeting_id
    AND status IN ('scheduled', 'open', 'draft')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Meeting % cannot receive AI draft outcomes in its current status',
      p_meeting_id;
  END IF;

  -- Optionally overwrite working_notes with the draft minutes
  IF p_working_notes IS NOT NULL THEN
    UPDATE meetings SET working_notes = p_working_notes WHERE id = p_meeting_id;
  END IF;

  -- Create proposed outcomes (preserving sort_order from caller)
  FOR v_outcome IN SELECT * FROM jsonb_array_elements(p_outcomes) LOOP
    INSERT INTO meeting_outcomes (
      meeting_id, kind, title, payload_json, sort_order,
      proposed_by_user_id, ai_draft_id, status
    ) VALUES (
      p_meeting_id,
      v_outcome->>'kind',
      v_outcome->>'title',
      COALESCE(v_outcome->'payload_json', '{}'),
      COALESCE((v_outcome->>'sort_order')::integer, 0),
      p_actor_user_id,
      p_draft_id,
      'proposed'
    );

    v_count := v_count + 1;
  END LOOP;

  -- Mark draft as applied
  UPDATE meeting_ai_drafts
  SET applied_at = now(), applied_by_user_id = p_actor_user_id
  WHERE id = p_draft_id;

  -- Audit event
  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.ai_draft_applied', 'meeting', p_meeting_id,
    jsonb_build_object(
      'draft_id',              p_draft_id,
      'outcomes_created',      v_count,
      'working_notes_updated', p_working_notes IS NOT NULL
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION apply_meeting_ai_draft_and_audit(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION apply_meeting_ai_draft_and_audit(uuid, uuid, uuid, text, jsonb) TO service_role;
