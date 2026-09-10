-- 054_audit_followups.sql
--
-- Red Flag follow-up data foundation.
--
-- When submit_audit() produces red_flag_count > 0 it automatically:
--   • Creates one audit_followup (due_at = submitted_at + 48 hours).
--   • Creates one audit_followup_response for every failed Red Flag checkpoint.
--
-- Design principles:
--   • The original audit is permanently immutable (unchanged).
--   • Follow-up records reference the original immutable submission and
--     checkpoints — content is never duplicated.
--   • Follow-up writes (status progression, response updates) are restricted
--     to management users (SA/UM) via RLS.
--   • Resolved follow-ups become fully immutable (trigger guard).
--   • Overdue is derived: due_at < now() AND status <> 'resolved'.
--     It is NOT stored as a column to avoid stale data.
--
-- Tables:
--   audit_followups          — one per audit submission (when RF count > 0)
--   audit_followup_responses — one per failed RF checkpoint per follow-up
--
-- SECURITY DEFINER RPC updated:
--   submit_audit() — extended to auto-create follow-up records at the end.

-- ===========================================================================
-- 1. Enum types
-- ===========================================================================

CREATE TYPE audit_followup_status AS ENUM ('pending', 'in_progress', 'resolved');
CREATE TYPE audit_followup_result AS ENUM ('resolved', 'not_resolved');

-- ===========================================================================
-- 2. audit_followups
-- ===========================================================================
--
-- One row per audit submission. Created automatically by submit_audit() when
-- red_flag_count > 0. The submission_id UNIQUE constraint enforces at most one
-- follow-up per audit run.

CREATE TABLE audit_followups (
  id            uuid                  NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  submission_id uuid                  NOT NULL REFERENCES audit_submissions(id),
  due_at        timestamptz           NOT NULL,
  status        audit_followup_status NOT NULL DEFAULT 'pending',
  completed_at  timestamptz,                     -- set by resolve_audit_followup()
  created_at    timestamptz           NOT NULL DEFAULT now(),
  updated_at    timestamptz           NOT NULL DEFAULT now(),

  -- One follow-up per submission maximum.
  UNIQUE (submission_id),

  -- completed_at is only meaningful once resolved.
  CONSTRAINT audit_followups_completed_at_requires_resolved
    CHECK (completed_at IS NULL OR status = 'resolved')
);

CREATE INDEX audit_followups_submission  ON audit_followups (submission_id);
-- Partial index for listing open follow-ups efficiently.
CREATE INDEX audit_followups_open        ON audit_followups (status, due_at)
  WHERE status <> 'resolved';

CREATE TRIGGER audit_followups_updated_at
  BEFORE UPDATE ON audit_followups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- 3. audit_followup_responses
-- ===========================================================================
--
-- One row per failed Red Flag checkpoint per follow-up.
-- Created automatically by submit_audit() alongside the parent follow-up.
-- Management updates result/comment/evidence_url to record resolution work.
-- result = NULL means the item has not yet been assessed in the follow-up.

CREATE TABLE audit_followup_responses (
  id            uuid                   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  followup_id   uuid                   NOT NULL REFERENCES audit_followups(id),
  checkpoint_id uuid                   NOT NULL REFERENCES audit_checkpoints(id),
  result        audit_followup_result,           -- NULL = not yet assessed
  comment       text,
  evidence_url  text,
  created_at    timestamptz            NOT NULL DEFAULT now(),
  updated_at    timestamptz            NOT NULL DEFAULT now(),

  -- One response per checkpoint per follow-up.
  UNIQUE (followup_id, checkpoint_id)
);

CREATE INDEX audit_followup_responses_followup ON audit_followup_responses (followup_id);

CREATE TRIGGER audit_followup_responses_updated_at
  BEFORE UPDATE ON audit_followup_responses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- 4. Immutability triggers
-- ===========================================================================

-- 4a. audit_followups — resolved follow-ups are fully immutable.

CREATE OR REPLACE FUNCTION _audit_followups_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION
      'audit_followups: resolved follow-ups are immutable (id: %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_followups_guard_immutable
  BEFORE UPDATE ON audit_followups
  FOR EACH ROW EXECUTE FUNCTION _audit_followups_guard_immutable();

-- 4b. audit_followup_responses — immutable once the parent follow-up is resolved.

CREATE OR REPLACE FUNCTION _audit_followup_responses_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_followup_id uuid;
  v_status      audit_followup_status;
BEGIN
  v_followup_id := COALESCE(NEW.followup_id, OLD.followup_id);
  SELECT status INTO v_status
  FROM audit_followups
  WHERE id = v_followup_id;

  IF v_status = 'resolved' THEN
    RAISE EXCEPTION
      'audit_followup_responses: responses for resolved follow-ups are immutable (followup id: %)',
      v_followup_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_followup_responses_guard_immutable
  BEFORE UPDATE ON audit_followup_responses
  FOR EACH ROW EXECUTE FUNCTION _audit_followup_responses_guard_immutable();

-- ===========================================================================
-- 5. Row-level security
-- ===========================================================================

ALTER TABLE audit_followups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_followup_responses ENABLE ROW LEVEL SECURITY;

-- ── audit_followups ──────────────────────────────────────────────────────────

-- Management reads all follow-ups.
CREATE POLICY "audit_followups: management can read all"
  ON audit_followups FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Auditor reads the follow-up for their own submission (read-only).
CREATE POLICY "audit_followups: auditor can read own"
  ON audit_followups FOR SELECT
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
    )
  );

-- Management may update status (pending → in_progress → resolved) and
-- completed_at on non-resolved follow-ups.
-- Immutability trigger provides a second layer of protection for resolved rows.
CREATE POLICY "audit_followups: management can update"
  ON audit_followups FOR UPDATE
  TO authenticated
  USING (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND status <> 'resolved'
  )
  WITH CHECK (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- No INSERT policy: created exclusively by submit_audit() (SECURITY DEFINER).
-- No DELETE policy: follow-ups are permanent records.

-- ── audit_followup_responses ─────────────────────────────────────────────────

-- Management reads all responses.
CREATE POLICY "audit_followup_responses: management can read all"
  ON audit_followup_responses FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Auditor reads responses for their own submission's follow-up (read-only).
CREATE POLICY "audit_followup_responses: auditor can read own"
  ON audit_followup_responses FOR SELECT
  TO authenticated
  USING (
    followup_id IN (
      SELECT f.id
      FROM audit_followups f
      JOIN audit_submissions s ON s.id = f.submission_id
      WHERE s.auditor_user_id = get_my_app_user_id()
    )
  );

-- Management may update result/comment/evidence_url on non-resolved follow-ups.
-- Immutability trigger enforces the resolved guard at the row level.
CREATE POLICY "audit_followup_responses: management can update"
  ON audit_followup_responses FOR UPDATE
  TO authenticated
  USING (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND (
      SELECT status FROM audit_followups WHERE id = followup_id
    ) <> 'resolved'
  )
  WITH CHECK (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- No INSERT policy: created exclusively by submit_audit() (SECURITY DEFINER).
-- No DELETE policy: follow-up responses are permanent records.

-- ===========================================================================
-- 6. submit_audit() — extended with Red Flag follow-up auto-creation
-- ===========================================================================
--
-- Signature unchanged: submit_audit(p_submission_id uuid, p_actor_user_id uuid)
--
-- New logic (step 17) appended after writing the final submission state:
--   • If red_flag_count > 0:
--       INSERT one audit_followup (due_at = now() + 48 hours, status = 'pending').
--       INSERT one audit_followup_response for each audit_response where
--         checkpoint.is_red_flag = true AND result = 'fail'.
--   • If red_flag_count = 0: no follow-up is created.
--
-- The INSERT uses service_role (SECURITY DEFINER), bypassing RLS, which is
-- why there is no INSERT RLS policy on these tables for regular users.
--
-- The original audit submission and all its data remain unchanged; the
-- follow-up tables only reference them by FK.

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

  -- Follow-up (step 17)
  v_followup_id     uuid;
BEGIN

  -- ── 1. Resolve actor role ─────────────────────────────────────────────────
  SELECT role INTO v_actor_role
  FROM app_users
  WHERE id = p_actor_user_id AND active = true;

  -- ── 2. Lock and fetch submission ──────────────────────────────────────────
  SELECT
    id, template_id, auditor_user_id, status,
    manager_on_duty,
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

      -- Fail with failure_requires_comment must have a non-empty comment
      IF v_response.result = 'fail'
         AND v_checkpoint.failure_requires_comment
         AND (v_response.comment IS NULL OR trim(v_response.comment) = '') THEN
        RAISE EXCEPTION
          'Failed checkpoint % requires a comment (submission: %)',
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
  --
  -- Only FAIL responses on is_red_flag checkpoints count.
  -- NOT ASSESSED on a Red Flag checkpoint does NOT count.

  SELECT COUNT(*)::integer
  INTO v_red_flag_count
  FROM audit_responses r
  JOIN audit_checkpoints c ON c.id = r.checkpoint_id
  WHERE r.submission_id = p_submission_id
    AND c.is_red_flag   = true
    AND r.result        = 'fail';

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

  -- Red Flag override: ANY Red Flag fail → RED regardless of score
  IF v_red_flag_count > 0 THEN
    v_audit_status := 'RED';
  END IF;

  -- ── 15. Manager warning ───────────────────────────────────────────────────
  v_mgr_warning := (v_red_flag_count >= 2);

  -- ── 16. Write final submission state ──────────────────────────────────────
  UPDATE audit_submissions
  SET
    status                   = 'submitted',
    -- Overall score
    score_pass               = v_score_pass,
    score_fail               = v_score_fail,
    score_na                 = v_score_na,
    score_total              = v_score_total,
    score_pct                = v_score_pct,
    -- Core score
    core_score_pass          = v_core_pass,
    core_score_fail          = v_core_fail,
    core_score_na            = v_core_na,
    core_score_total         = v_core_total,
    core_score_pct           = v_core_pct,
    -- Red Flags and status
    red_flag_count           = v_red_flag_count,
    audit_status             = v_audit_status,
    manager_warning_required = v_mgr_warning,
    -- Timestamps
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
      'status',                   'submitted',
      'score_pct',                v_score_pct,
      'core_score_pct',           v_core_pct,
      'red_flag_count',           v_red_flag_count,
      'audit_status',             v_audit_status,
      'manager_warning_required', v_mgr_warning
    )
  );

  -- ── 17. Auto-create Red Flag follow-up ────────────────────────────────────
  --
  -- Runs only when one or more Red Flags failed.
  -- due_at = now() + 48 hours. now() is the same transaction timestamp that
  -- was written to submitted_at in step 16, so due_at = submitted_at + 48h.
  --
  -- One audit_followup per submission (enforced by UNIQUE constraint).
  -- One audit_followup_response per failed RF checkpoint.

  IF v_red_flag_count > 0 THEN
    INSERT INTO audit_followups (submission_id, due_at, status)
    VALUES (p_submission_id, now() + interval '48 hours', 'pending')
    RETURNING id INTO v_followup_id;

    INSERT INTO audit_followup_responses (followup_id, checkpoint_id)
    SELECT v_followup_id, r.checkpoint_id
    FROM audit_responses r
    JOIN audit_checkpoints c ON c.id = r.checkpoint_id
    WHERE r.submission_id = p_submission_id
      AND c.is_red_flag   = true
      AND r.result        = 'fail';
  END IF;

END;
$$;

REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_audit(uuid, uuid) TO service_role;
