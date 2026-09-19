-- Migration 075: meeting lifecycle automation
--
-- Adds columns used by the automated Google Meet conference reconciliation job
-- to track whether a meeting's lifecycle has been resolved from Meet records.
--
-- conference_record_name:  the Google conference record resource name once
--   detected (e.g. "conferenceRecords/abc..."). Used for idempotency.
-- meet_lifecycle_resolved: set to true once the meeting has been automatically
--   transitioned to draft based on conference end time. Prevents double-processing.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS conference_record_name  text,
  ADD COLUMN IF NOT EXISTS meet_lifecycle_resolved boolean NOT NULL DEFAULT false;

-- Backfill: meetings that are no longer active don't need reconciliation.
-- This keeps the index small and the reconciler fast.
UPDATE meetings
  SET meet_lifecycle_resolved = true
  WHERE status NOT IN ('scheduled', 'open');

-- Index: reconciler only scans meetings that are pending reconciliation
CREATE INDEX meetings_lifecycle_pending_idx
  ON meetings (scheduled_start)
  WHERE meet_space_name IS NOT NULL
    AND meet_lifecycle_resolved = false
    AND status IN ('scheduled', 'open');


-- ─── reconcile_meeting_from_meet ───────────────────────────────────────────────
--
-- Called by the automated reconciliation job (never by a human user).
-- Atomically transitions a scheduled/open meeting to draft using actual
-- start/end times obtained from the Google Meet conference record.
--
-- Guards:
--   • No-ops if meet_lifecycle_resolved = true (already processed).
--   • No-ops if the meeting is not in 'scheduled' or 'open' status.
--
-- actual_start is preserved if already set (meeting was manually opened first).
-- Actor type is 'system'; actor_user_id is NULL.

CREATE OR REPLACE FUNCTION reconcile_meeting_from_meet(
  p_meeting_id              UUID,
  p_conference_record_name  TEXT,
  p_actual_start            TIMESTAMPTZ,
  p_actual_end              TIMESTAMPTZ
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM   meetings
  WHERE  id = p_meeting_id AND meet_lifecycle_resolved = false
  FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_status NOT IN ('scheduled', 'open') THEN RETURN; END IF;

  UPDATE meetings SET
    status                  = 'draft',
    actual_start            = COALESCE(actual_start, p_actual_start),
    actual_end              = p_actual_end,
    conference_record_name  = p_conference_record_name,
    meet_lifecycle_resolved = true
  WHERE id = p_meeting_id;

  INSERT INTO audit_events (
    actor_user_id, actor_type, action,
    entity_type,   entity_id,  before_json, after_json
  ) VALUES (
    NULL,
    'system',
    'meeting.closed_to_draft',
    'meeting',
    p_meeting_id,
    jsonb_build_object('status', v_status),
    jsonb_build_object(
      'status',                 'draft',
      'conference_record_name', p_conference_record_name,
      'actual_start',           p_actual_start,
      'actual_end',             p_actual_end
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reconcile_meeting_from_meet(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
