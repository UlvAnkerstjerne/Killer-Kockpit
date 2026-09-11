-- 059_diner_scoring.sql
--
-- Adds final_status to diner_submissions and updates submit_diner_submission()
-- to compute and store it using the correct status rules.
--
-- Status rules (mirrored in lib/diner/scoring.ts):
--   86–100% = GREEN
--   67–85%  = YELLOW
--   <67%    = RED
--
-- Critical cap:
--   Any critical_fail_count > 0 prevents GREEN → cap to YELLOW.
--   Does not force RED — status is only downgraded from GREEN, not from YELLOW.
--
-- Existing submitted submissions will have final_status = NULL.
-- The TypeScript layer falls back to computeDinerStatus() for those rows.

-- ===========================================================================
-- 1. Add final_status column
-- ===========================================================================

ALTER TABLE diner_submissions
  ADD COLUMN final_status text
    CONSTRAINT diner_submissions_final_status_check
    CHECK (final_status IN ('GREEN', 'YELLOW', 'RED'));

-- ===========================================================================
-- 2. Replace submit_diner_submission() — same jsonb return type
-- ===========================================================================
--
-- Return type is still jsonb (same as 058), so we can DROP + CREATE.

DROP FUNCTION IF EXISTS submit_diner_submission(uuid, uuid);

CREATE FUNCTION submit_diner_submission(
  p_submission_id uuid,
  p_invitation_id uuid
)
RETURNS jsonb
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_status         text;
  v_scored_total   int     := 0;
  v_pass_count     int     := 0;
  v_critical_fails int     := 0;
  v_gold_stars     int     := 0;
  v_waiting_band   text;
  v_score_pct      numeric(5,2);
  v_final_status   text;
BEGIN
  -- Lock the row to serialise concurrent submits
  SELECT status INTO v_status
  FROM diner_submissions
  WHERE id = p_submission_id AND invitation_id = p_invitation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission not found or invitation mismatch';
  END IF;

  IF v_status = 'submitted' THEN
    RAISE EXCEPTION 'Already submitted';
  END IF;

  -- Compute scores from saved responses.
  -- Only responses present count — conditional checkpoints absent for short waits.
  SELECT
    COUNT(*)      FILTER (WHERE cp.type = 'scored' AND dr.result IN ('pass', 'fail')),
    COUNT(*)      FILTER (WHERE cp.type = 'scored' AND dr.result = 'pass'),
    COUNT(*)      FILTER (WHERE cp.type = 'scored' AND cp.is_critical AND dr.result = 'fail'),
    COUNT(*)      FILTER (WHERE cp.type = 'gold_star' AND dr.result = 'pass'),
    MAX(dr.notes) FILTER (WHERE cp.type = 'waiting_time')
  INTO v_scored_total, v_pass_count, v_critical_fails, v_gold_stars, v_waiting_band
  FROM diner_responses dr
  JOIN diner_checkpoints cp ON cp.id = dr.checkpoint_id
  WHERE dr.submission_id = p_submission_id;

  -- 20+ minute wait counts as one additional critical failure
  IF v_waiting_band = '20+' THEN
    v_critical_fails := COALESCE(v_critical_fails, 0) + 1;
  END IF;

  -- Score and status computation
  IF COALESCE(v_scored_total, 0) > 0 THEN
    v_score_pct := ROUND(COALESCE(v_pass_count, 0)::numeric / v_scored_total * 100, 2);

    -- Base status thresholds
    IF v_score_pct >= 86 THEN
      v_final_status := 'GREEN';
    ELSIF v_score_pct >= 67 THEN
      v_final_status := 'YELLOW';
    ELSE
      v_final_status := 'RED';
    END IF;

    -- Critical cap: any critical failure prevents GREEN
    IF COALESCE(v_critical_fails, 0) > 0 AND v_final_status = 'GREEN' THEN
      v_final_status := 'YELLOW';
    END IF;
  END IF;

  -- Persist (immutability trigger allows in_progress → submitted transition)
  UPDATE diner_submissions
  SET status              = 'submitted',
      submitted_at        = now(),
      score_pct           = v_score_pct,
      critical_fail_count = COALESCE(v_critical_fails, 0),
      gold_star_count     = COALESCE(v_gold_stars, 0),
      waiting_time_band   = v_waiting_band,
      final_status        = v_final_status
  WHERE id = p_submission_id;

  -- Sync invitation status
  UPDATE diner_invitations
  SET status     = 'submitted',
      updated_at = now()
  WHERE id = p_invitation_id;

  RETURN jsonb_build_object(
    'status',              'submitted',
    'score_pct',           v_score_pct,
    'critical_fail_count', COALESCE(v_critical_fails, 0),
    'gold_star_count',     COALESCE(v_gold_stars, 0),
    'waiting_time_band',   v_waiting_band,
    'final_status',        v_final_status
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) TO service_role;
