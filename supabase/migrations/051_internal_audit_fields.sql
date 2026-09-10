-- 051_internal_audit_fields.sql
--
-- Extends the Internal Audit foundation (050) with the full Master Operational
-- Audit data model.
--
-- Changes:
--
-- 1. New enum: audit_health_status (GREEN | LIGHT_GREEN | YELLOW | ORANGE | RED)
--
-- 2. audit_checkpoints — add classification columns:
--      is_core_standard boolean NOT NULL DEFAULT false
--      is_red_flag      boolean NOT NULL DEFAULT false
--    Constraint: is_red_flag = true implies is_core_standard = true.
--    Spec: "Every Red Flag is ALSO a Core Standard. Store both separately."
--
-- 3. audit_submissions — add:
--      manager_on_duty          text          (required at submission)
--      core_score_*             integer/numeric (computed by submit_audit())
--      red_flag_count           integer       (computed by submit_audit())
--      audit_status             audit_health_status (computed by submit_audit())
--      manager_warning_required boolean       (set when red_flag_count >= 2)
--      final_done_well          text          (required at submission)
--      final_focus_next         text          (required at submission)
--      final_overall_comments   text          (optional)
--      final_mod_informed       boolean       (Yes/No)
--      final_corrective_action  text          (optional; required when red_flag_count > 0)
--      follow_up_requested      boolean       (non-RF additional follow-up)
--      follow_up_date           date          (required when follow_up_requested = true)
--
-- 4. audit_section_comments — optional per-section text, one row per section
--    per submission. Writable while in_progress; immutable after submission.
--
-- 5. audit_top_actions — up to 3 structured actions per submission (action,
--    owner, deadline all required per row). Writable while in_progress;
--    immutable after submission. Deletable while in_progress.
--
-- 6. Immutability triggers for both new tables (same pattern as audit_responses).
--
-- 7. RLS for both new tables (visibility mirrors parent submission visibility).
--
-- 8. submit_audit() updated — now also:
--    • validates manager_on_duty, final_done_well, final_focus_next
--    • validates follow_up_date when follow_up_requested = true
--    • computes Core Score from is_core_standard checkpoints
--    • counts fails on is_red_flag checkpoints
--    • requires final_corrective_action when red_flag_count > 0
--    • determines audit_status from WORSE of overall_pct and core_pct:
--        >= 90 → GREEN, >= 80 → LIGHT_GREEN, >= 70 → YELLOW,
--        >= 60 → ORANGE, < 60 → RED
--    • overrides audit_status to RED if any Red Flag fails
--    • sets manager_warning_required when red_flag_count >= 2

-- ===========================================================================
-- 1. audit_health_status enum
-- ===========================================================================

CREATE TYPE audit_health_status AS ENUM ('GREEN', 'LIGHT_GREEN', 'YELLOW', 'ORANGE', 'RED');

-- ===========================================================================
-- 2. audit_checkpoints — classification columns
-- ===========================================================================

ALTER TABLE audit_checkpoints
  ADD COLUMN is_core_standard boolean NOT NULL DEFAULT false,
  ADD COLUMN is_red_flag      boolean NOT NULL DEFAULT false;

-- Red Flag implies Core Standard (both stored separately per spec).
ALTER TABLE audit_checkpoints
  ADD CONSTRAINT audit_checkpoints_red_flag_implies_core
    CHECK (NOT is_red_flag OR is_core_standard);

-- Partial indexes for score-computation joins in submit_audit().
CREATE INDEX audit_checkpoints_template_core
  ON audit_checkpoints (template_id)
  WHERE is_core_standard = true;

CREATE INDEX audit_checkpoints_template_rf
  ON audit_checkpoints (template_id)
  WHERE is_red_flag = true;

-- ===========================================================================
-- 3. audit_submissions — new columns
-- ===========================================================================

ALTER TABLE audit_submissions
  ADD COLUMN manager_on_duty          text,
  ADD COLUMN core_score_pass          integer,
  ADD COLUMN core_score_fail          integer,
  ADD COLUMN core_score_na            integer,
  ADD COLUMN core_score_total         integer,          -- core_pass + core_fail
  ADD COLUMN core_score_pct           numeric(5, 2),    -- core_pass / core_total * 100
  ADD COLUMN red_flag_count           integer,
  ADD COLUMN audit_status             audit_health_status,
  ADD COLUMN manager_warning_required boolean       NOT NULL DEFAULT false,
  ADD COLUMN final_done_well          text,
  ADD COLUMN final_focus_next         text,
  ADD COLUMN final_overall_comments   text,
  ADD COLUMN final_mod_informed       boolean,
  ADD COLUMN final_corrective_action  text,
  ADD COLUMN follow_up_requested      boolean       NOT NULL DEFAULT false,
  ADD COLUMN follow_up_date           date;

ALTER TABLE audit_submissions
  ADD CONSTRAINT audit_submissions_core_score_pct_range
    CHECK (core_score_pct IS NULL OR (core_score_pct >= 0 AND core_score_pct <= 100));

-- ===========================================================================
-- 4. audit_section_comments
-- ===========================================================================
--
-- One optional comment per section per submission.
-- Section value matches audit_checkpoints.section for the template.
-- Writable while submission is in_progress; blocked after submission by trigger.

CREATE TABLE audit_section_comments (
  id            uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  submission_id uuid        NOT NULL REFERENCES audit_submissions(id),
  section       text        NOT NULL,
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_section_comments_section_not_empty CHECK (trim(section) <> ''),
  UNIQUE (submission_id, section)
);

CREATE INDEX audit_section_comments_submission
  ON audit_section_comments (submission_id);

CREATE TRIGGER audit_section_comments_updated_at
  BEFORE UPDATE ON audit_section_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- 5. audit_top_actions
-- ===========================================================================
--
-- Up to 3 structured follow-up actions per submission.
-- sort_order is 1, 2, or 3 — not forced to exactly 3.
-- action, owner, deadline are all required per row.
-- Writable while submission is in_progress; blocked after submission by trigger.
-- DELETE is permitted while in_progress so auditors can remove actions.

CREATE TABLE audit_top_actions (
  id            uuid     NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  submission_id uuid     NOT NULL REFERENCES audit_submissions(id),
  sort_order    smallint NOT NULL,
  action        text     NOT NULL,
  owner         text     NOT NULL,
  deadline      date     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_top_actions_sort_order_range CHECK (sort_order BETWEEN 1 AND 3),
  CONSTRAINT audit_top_actions_action_not_empty CHECK (trim(action) <> ''),
  CONSTRAINT audit_top_actions_owner_not_empty  CHECK (trim(owner) <> ''),
  UNIQUE (submission_id, sort_order)
);

CREATE INDEX audit_top_actions_submission
  ON audit_top_actions (submission_id);

CREATE TRIGGER audit_top_actions_updated_at
  BEFORE UPDATE ON audit_top_actions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- 6. Immutability triggers for new tables
-- ===========================================================================

-- 6a. audit_section_comments — immutable once parent submission is submitted.

CREATE OR REPLACE FUNCTION _audit_section_comments_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status audit_submission_status;
BEGIN
  SELECT status INTO v_status
  FROM audit_submissions
  WHERE id = OLD.submission_id;

  IF v_status = 'submitted' THEN
    RAISE EXCEPTION
      'audit_section_comments: submitted audit records are immutable (submission id: %)',
      OLD.submission_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_section_comments_guard_immutable
  BEFORE UPDATE OR DELETE ON audit_section_comments
  FOR EACH ROW EXECUTE FUNCTION _audit_section_comments_guard_immutable();

-- 6b. audit_top_actions — immutable once parent submission is submitted.

CREATE OR REPLACE FUNCTION _audit_top_actions_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status audit_submission_status;
BEGIN
  SELECT status INTO v_status
  FROM audit_submissions
  WHERE id = OLD.submission_id;

  IF v_status = 'submitted' THEN
    RAISE EXCEPTION
      'audit_top_actions: submitted audit records are immutable (submission id: %)',
      OLD.submission_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_top_actions_guard_immutable
  BEFORE UPDATE OR DELETE ON audit_top_actions
  FOR EACH ROW EXECUTE FUNCTION _audit_top_actions_guard_immutable();

-- ===========================================================================
-- 7. Row-level security for new tables
-- ===========================================================================
--
-- Visibility mirrors the parent submission:
--   • Auditor reads/writes their own (in_progress for mutations).
--   • Management reads all.
-- No INSERT policy for management — only the auditor may build their audit.
-- DELETE is permitted on in_progress submissions to allow removing top actions.

ALTER TABLE audit_section_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_top_actions      ENABLE ROW LEVEL SECURITY;

-- ── audit_section_comments ───────────────────────────────────────────────────

CREATE POLICY "audit_section_comments: auditor can read own"
  ON audit_section_comments FOR SELECT
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
    )
  );

CREATE POLICY "audit_section_comments: management can read all"
  ON audit_section_comments FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

CREATE POLICY "audit_section_comments: auditor can insert"
  ON audit_section_comments FOR INSERT
  TO authenticated
  WITH CHECK (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  );

CREATE POLICY "audit_section_comments: auditor can update"
  ON audit_section_comments FOR UPDATE
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  )
  WITH CHECK (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  );

CREATE POLICY "audit_section_comments: auditor can delete"
  ON audit_section_comments FOR DELETE
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  );

-- ── audit_top_actions ────────────────────────────────────────────────────────

CREATE POLICY "audit_top_actions: auditor can read own"
  ON audit_top_actions FOR SELECT
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
    )
  );

CREATE POLICY "audit_top_actions: management can read all"
  ON audit_top_actions FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

CREATE POLICY "audit_top_actions: auditor can insert"
  ON audit_top_actions FOR INSERT
  TO authenticated
  WITH CHECK (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  );

CREATE POLICY "audit_top_actions: auditor can update"
  ON audit_top_actions FOR UPDATE
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  )
  WITH CHECK (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  );

CREATE POLICY "audit_top_actions: auditor can delete"
  ON audit_top_actions FOR DELETE
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  );

-- ===========================================================================
-- 8. submit_audit() — extended
-- ===========================================================================
--
-- Signature unchanged: submit_audit(p_submission_id uuid, p_actor_user_id uuid)
--
-- New logic beyond migration 050:
--   • Validates manager_on_duty (required, non-empty).
--   • Validates final_done_well (required, non-empty).
--   • Validates final_focus_next (required, non-empty).
--   • Validates follow_up_date is set when follow_up_requested = true.
--   • Computes Core Score using only is_core_standard checkpoints.
--   • Counts Red Flags: FAIL responses on is_red_flag checkpoints only.
--     (NOT ASSESSED on a Red Flag checkpoint does NOT count as a failed RF.)
--   • Requires final_corrective_action (non-empty) when red_flag_count > 0.
--   • Determines audit_status from WORSE of overall_pct and core_pct:
--       >= 90  → GREEN
--       >= 80  → LIGHT_GREEN
--       >= 70  → YELLOW
--       >= 60  → ORANGE
--       <  60  → RED
--     "Worse" = LEAST of the two percentages (NULL-safe).
--   • Overrides audit_status to RED if red_flag_count > 0.
--   • Sets manager_warning_required when red_flag_count >= 2.
--
-- Trigger compatibility:
--   _audit_submissions_guard fires BEFORE UPDATE. When this function runs,
--   OLD.status = 'in_progress' (guard i passes), template_id and auditor_user_id
--   are unchanged (guards ii/iii pass). No conflict.

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
  --
  -- pass / (pass + fail) — na and NULL excluded from denominator.

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
  --
  -- Across is_core_standard checkpoints only.
  -- na excluded from denominator.

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
  -- NOT ASSESSED on a Red Flag checkpoint does NOT count as a failed Red Flag.

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
  --
  -- When no Red Flags: classify by WORSE of overall_pct and core_pct.
  -- "Worse" = LEAST of the two (lower score = worse health).
  -- NULL-safe: if one is NULL (no assessed responses in that category), use the other.
  -- If both NULL: status remains NULL (no assessed responses at all — edge case).

  IF v_score_pct IS NOT NULL OR v_core_pct IS NOT NULL THEN
    v_worse_pct := LEAST(
      COALESCE(v_score_pct, v_core_pct),   -- if overall NULL, fall back to core
      COALESCE(v_core_pct,  v_score_pct)   -- if core NULL, fall back to overall
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

  -- ── 16. Write final state ─────────────────────────────────────────────────
  --
  -- _audit_submissions_guard fires BEFORE this UPDATE.
  -- OLD.status = 'in_progress' → guard passes.
  -- template_id and auditor_user_id are unchanged → guards pass.

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
      'status',                  'submitted',
      'score_pct',               v_score_pct,
      'core_score_pct',          v_core_pct,
      'red_flag_count',          v_red_flag_count,
      'audit_status',            v_audit_status,
      'manager_warning_required', v_mgr_warning
    )
  );
END;
$$;

-- REVOKE explicitly from anon and authenticated (CREATE OR REPLACE preserves
-- existing grants from 050, but be explicit for clarity and idempotency).
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_audit(uuid, uuid) TO service_role;
