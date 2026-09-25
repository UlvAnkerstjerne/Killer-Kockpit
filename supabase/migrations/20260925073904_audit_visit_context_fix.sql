-- 20260925000000_audit_visit_context.sql
--
-- Adds visit-level metadata and unacceptable-checkpoint context to KQC audits.
--
-- Changes:
--
-- 1. audit_submissions — new columns:
--      visited_at  timestamptz  — timestamp when the audit visit was started
--      busyness    text         — operating conditions during the visit
--                                 (Full rush | Busy | Chill | Slow | Dead)
--
-- 2. submit_audit() — updated validation:
--      • busyness must be set (non-NULL, valid value) before submission
--      • ALL fail responses must have a non-empty comment (context),
--        not just those with failure_requires_comment = true
--
-- Backfill: existing in_progress submissions get visited_at = created_at.
--           Existing submitted audits are unaffected (already past validation).

-- ===========================================================================
-- 1. New columns on audit_submissions
-- ===========================================================================

ALTER TABLE audit_submissions
  ADD COLUMN visited_at timestamptz,
  ADD COLUMN busyness   text;

-- Temporarily disable immutability guard so we can backfill submitted rows
ALTER TABLE audit_submissions DISABLE TRIGGER audit_submissions_guard;

-- Backfill visited_at for all existing rows from created_at
UPDATE audit_submissions SET visited_at = created_at WHERE visited_at IS NULL;

-- Re-enable immutability guard
ALTER TABLE audit_submissions ENABLE TRIGGER audit_submissions_guard;

-- Now make it NOT NULL for new rows
ALTER TABLE audit_submissions ALTER COLUMN visited_at SET NOT NULL;
ALTER TABLE audit_submissions ALTER COLUMN visited_at SET DEFAULT now();

-- Constrain busyness to the five valid values (NULL allowed until submission)
ALTER TABLE audit_submissions
  ADD CONSTRAINT audit_submissions_busyness_valid
    CHECK (busyness IS NULL OR busyness IN ('Full rush', 'Busy', 'Chill', 'Slow', 'Dead'));

-- ===========================================================================
-- 2. submit_audit() — extended validation
-- ===========================================================================
--
-- Adds two new checks before the existing checkpoint loop:
--   • busyness must be set
--   • ALL fail responses must have a non-empty comment
--
-- The rest of the function is unchanged from 051_internal_audit_fields.sql +
-- 054_audit_followups.sql. We CREATE OR REPLACE the full function body to
-- incorporate the new checks.

CREATE OR REPLACE FUNCTION submit_audit(
  p_submission_id uuid,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_actor_role      kk_role;
  v_submission      RECORD;
  v_template_status audit_template_status;
  v_checkpoint      RECORD;
  v_response        RECORD;

  -- Overall score accumulators
  v_score_pass      integer := 0;
  v_score_fail      integer := 0;
  v_score_na        integer := 0;
  v_score_total     integer;
  v_score_pct       numeric(5, 2);

  -- Core score accumulators
  v_core_pass       integer := 0;
  v_core_fail       integer := 0;
  v_core_na         integer := 0;
  v_core_total      integer;
  v_core_pct        numeric(5, 2);

  -- Red Flag count
  v_red_flag_count  integer := 0;

  -- Final status
  v_worse_pct       numeric(5, 2);
  v_audit_status    audit_health_status;
  v_mgr_warning     boolean;
BEGIN

  -- ── 1. Resolve actor role ─────────────────────────────────────────────────
  SELECT role INTO v_actor_role
  FROM app_users
  WHERE id = p_actor_user_id AND active = true;

  -- ── 2. Lock and fetch submission ──────────────────────────────────────────
  SELECT
    id, template_id, auditor_user_id, status,
    manager_on_duty, busyness,
    final_done_well, final_focus_next,
    final_corrective_action,
    follow_up_requested, follow_up_date
  INTO v_submission
  FROM audit_submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit submission not found: %', p_submission_id;
  END IF;

  -- ── 3. Authorise ──────────────────────────────────────────────────────────
  IF v_submission.auditor_user_id <> p_actor_user_id
     AND (v_actor_role IS NULL OR v_actor_role NOT IN ('SUPER_ADMIN', 'UM')) THEN
    RAISE EXCEPTION
      'Not authorised: only the auditor or management may submit this audit (submission: %)',
      p_submission_id;
  END IF;

  -- ── 4. Submission must be in_progress ────────────────────────────────────
  IF v_submission.status <> 'in_progress' THEN
    RAISE EXCEPTION
      'Only in_progress submissions can be submitted (current status: %)',
      v_submission.status;
  END IF;

  -- ── 5. Template must not be draft ────────────────────────────────────────
  SELECT status INTO v_template_status
  FROM audit_templates
  WHERE id = v_submission.template_id;

  IF v_template_status = 'draft' THEN
    RAISE EXCEPTION
      'Cannot submit an audit against a draft template (template id: %)',
      v_submission.template_id;
  END IF;

  -- ── 6. Validate Manager on Duty ───────────────────────────────────────────
  IF v_submission.manager_on_duty IS NULL
     OR trim(v_submission.manager_on_duty) = '' THEN
    RAISE EXCEPTION 'Manager on Duty is required before submission';
  END IF;

  -- ── 6b. Validate Busyness ─────────────────────────────────────────────────
  IF v_submission.busyness IS NULL THEN
    RAISE EXCEPTION 'Busyness level is required before submission';
  END IF;

  -- ── 7. Validate required final-comment fields ─────────────────────────────
  IF v_submission.final_done_well IS NULL
     OR trim(v_submission.final_done_well) = '' THEN
    RAISE EXCEPTION '"What was done well?" is required before submission';
  END IF;

  IF v_submission.final_focus_next IS NULL
     OR trim(v_submission.final_focus_next) = '' THEN
    RAISE EXCEPTION '"Main focus before next audit" is required before submission';
  END IF;

  -- ── 8. follow_up_date required when follow_up_requested ───────────────────
  IF v_submission.follow_up_requested AND v_submission.follow_up_date IS NULL THEN
    RAISE EXCEPTION 'A follow-up date is required when additional follow-up is requested';
  END IF;

  -- ── 9. Validate each checkpoint ───────────────────────────────────────────
  FOR v_checkpoint IN
    SELECT id, required, allow_na, failure_requires_comment,
           is_core_standard, is_red_flag
    FROM audit_checkpoints
    WHERE template_id = v_submission.template_id
    ORDER BY sort_order
  LOOP
    SELECT result, comment
    INTO v_response
    FROM audit_responses
    WHERE submission_id = p_submission_id
      AND checkpoint_id = v_checkpoint.id;

    -- Required checkpoints must have a non-NULL result
    IF v_checkpoint.required AND (NOT FOUND OR v_response.result IS NULL) THEN
      RAISE EXCEPTION
        'Required checkpoint % has no answer (submission: %)',
        v_checkpoint.id, p_submission_id;
    END IF;

    IF FOUND AND v_response.result IS NOT NULL THEN
      -- N/A only permitted where allow_na = true
      IF v_response.result = 'na' AND NOT v_checkpoint.allow_na THEN
        RAISE EXCEPTION
          'Checkpoint % does not allow N/A responses (submission: %)',
          v_checkpoint.id, p_submission_id;
      END IF;

      -- ALL fail responses must have a non-empty comment (context)
      IF v_response.result = 'fail'
         AND (v_response.comment IS NULL OR trim(v_response.comment) = '') THEN
        RAISE EXCEPTION
          'Every Unacceptable checkpoint requires context — checkpoint % is missing a comment (submission: %)',
          v_checkpoint.id, p_submission_id;
      END IF;
    END IF;
  END LOOP;

  -- ── 10. Compute Overall Score ─────────────────────────────────────────────
  SELECT
    COUNT(*) FILTER (WHERE r.result = 'pass')::integer,
    COUNT(*) FILTER (WHERE r.result = 'fail')::integer,
    COUNT(*) FILTER (WHERE r.result = 'na')::integer
  INTO v_score_pass, v_score_fail, v_score_na
  FROM audit_responses r
  WHERE r.submission_id = p_submission_id;

  v_score_total := v_score_pass + v_score_fail;
  v_score_pct   := CASE
    WHEN v_score_total > 0
    THEN round((v_score_pass::numeric / v_score_total) * 100, 2)
    ELSE NULL
  END;

  -- ── 11. Compute Core Score ────────────────────────────────────────────────
  SELECT
    COUNT(*) FILTER (WHERE r.result = 'pass')::integer,
    COUNT(*) FILTER (WHERE r.result = 'fail')::integer,
    COUNT(*) FILTER (WHERE r.result = 'na')::integer
  INTO v_core_pass, v_core_fail, v_core_na
  FROM audit_responses r
  JOIN audit_checkpoints c ON c.id = r.checkpoint_id
  WHERE r.submission_id = p_submission_id
    AND c.is_core_standard = true;

  v_core_total := v_core_pass + v_core_fail;
  v_core_pct   := CASE
    WHEN v_core_total > 0
    THEN round((v_core_pass::numeric / v_core_total) * 100, 2)
    ELSE NULL
  END;

  -- ── 12. Count failed Red Flags ────────────────────────────────────────────
  SELECT COUNT(*)::integer
  INTO v_red_flag_count
  FROM audit_responses r
  JOIN audit_checkpoints c ON c.id = r.checkpoint_id
  WHERE r.submission_id  = p_submission_id
    AND c.is_red_flag    = true
    AND r.result         = 'fail';

  -- ── 13. Corrective action required if any Red Flag fails ──────────────────
  IF v_red_flag_count > 0 THEN
    IF v_submission.final_corrective_action IS NULL
       OR trim(v_submission.final_corrective_action) = '' THEN
      RAISE EXCEPTION
        'Immediate corrective action must be recorded when Red Flags are present (submission: %)',
        p_submission_id;
    END IF;
  END IF;

  -- ── 14. Determine audit_status ────────────────────────────────────────────
  IF v_score_pct IS NOT NULL OR v_core_pct IS NOT NULL THEN
    v_worse_pct := LEAST(
      COALESCE(v_score_pct, v_core_pct),
      COALESCE(v_core_pct,  v_score_pct)
    );
    v_audit_status := CASE
      WHEN v_worse_pct >= 90 THEN 'GREEN'::audit_health_status
      WHEN v_worse_pct >= 80 THEN 'LIGHT_GREEN'::audit_health_status
      WHEN v_worse_pct >= 70 THEN 'YELLOW'::audit_health_status
      WHEN v_worse_pct >= 60 THEN 'ORANGE'::audit_health_status
      ELSE                        'RED'::audit_health_status
    END;
  ELSE
    v_audit_status := NULL;
  END IF;

  IF v_red_flag_count > 0 THEN
    v_audit_status := 'RED';
  END IF;

  -- ── 15. Manager warning ───────────────────────────────────────────────────
  v_mgr_warning := (v_red_flag_count >= 2);

  -- ── 16. Write final state ─────────────────────────────────────────────────
  UPDATE audit_submissions
  SET
    status                   = 'submitted',
    score_pass               = v_score_pass,
    score_fail               = v_score_fail,
    score_na                 = v_score_na,
    score_total              = v_score_total,
    score_pct                = v_score_pct,
    core_score_pass          = v_core_pass,
    core_score_fail          = v_core_fail,
    core_score_na            = v_core_na,
    core_score_total         = v_core_total,
    core_score_pct           = v_core_pct,
    red_flag_count           = v_red_flag_count,
    audit_status             = v_audit_status,
    manager_warning_required = v_mgr_warning,
    submitted_at             = now(),
    updated_at               = now()
  WHERE id = p_submission_id;

  INSERT INTO audit_events (
    actor_user_id, actor_type, action, entity_type, entity_id,
    before_json, after_json
  )
  VALUES (
    p_actor_user_id, 'human',
    'audit_submission.submitted', 'audit_submission', p_submission_id,
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object(
      'status',                  'submitted',
      'score_pct',               v_score_pct,
      'core_score_pct',          v_core_pct,
      'red_flag_count',          v_red_flag_count,
      'audit_status',            v_audit_status,
      'manager_warning_required', v_mgr_warning
    )
  );

  -- ── 17. Auto-create follow-up if Red Flags present ────────────────────────
  IF v_red_flag_count > 0 THEN
    INSERT INTO audit_followups (submission_id, due_at, status)
    VALUES (p_submission_id, now() + interval '48 hours', 'pending')
    ON CONFLICT (submission_id) DO NOTHING;

    INSERT INTO audit_followup_responses (followup_id, checkpoint_id)
    SELECT f.id, r.checkpoint_id
    FROM audit_followups f
    JOIN audit_responses r ON r.submission_id = f.submission_id
    JOIN audit_checkpoints c ON c.id = r.checkpoint_id
    WHERE f.submission_id = p_submission_id
      AND c.is_red_flag = true
      AND r.result = 'fail'
    ON CONFLICT (followup_id, checkpoint_id) DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_audit(uuid, uuid) TO service_role;
