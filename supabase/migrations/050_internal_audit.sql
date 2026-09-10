-- 050_internal_audit.sql
--
-- Internal Audit — four-table foundation.
--
-- Tables:
--   audit_templates    — versioned protocol definitions (draft → published → retired)
--   audit_checkpoints  — immutable checklist items belonging to a template version
--   audit_submissions  — per-location audit runs (in_progress → submitted)
--   audit_responses    — per-checkpoint answers (NULL | pass | fail | na)
--
-- Integrity rules enforced at the database layer:
--   • Only one published template per audit_key at any time
--     (partial unique index + publish RPC retires predecessor atomically).
--   • Published and retired templates are protected from direct mutation via RLS:
--       UPDATE USING (status = 'draft') blocks edits to published/retired rows.
--       UPDATE WITH CHECK (status = 'draft') prevents direct status promotion.
--     The publish_audit_template() RPC is SECURITY DEFINER and bypasses RLS.
--     It performs its own authorization and uses atomic UPDATE to change status.
--   • audit_checkpoints are immutable once their template is published/retired
--     (BEFORE UPDATE/DELETE trigger).
--   • New submissions must reference a currently published template and an
--     active location (RLS WITH CHECK on audit_submissions INSERT).
--   • audit_submissions.template_id and auditor_user_id are immutable after INSERT
--     (BEFORE UPDATE trigger on audit_submissions).
--   • Submitted audits and their responses are immutable
--     (BEFORE UPDATE/DELETE triggers on audit_submissions and audit_responses).
--   • submit_audit() accepts published or retired templates, never draft.
--   • Final scores, status and submitted_at are written only by submit_audit().
--   • N/A responses are only permitted on checkpoints with allow_na = true.
--   • Failed checkpoints with failure_requires_comment = true must have a comment.
--
-- SECURITY DEFINER RPCs (service_role only):
--   publish_audit_template(p_template_id uuid, p_actor_user_id uuid)
--   submit_audit(p_submission_id uuid, p_actor_user_id uuid)
--
-- Note on triggers vs SECURITY DEFINER:
--   SECURITY DEFINER bypasses RLS but NOT triggers. audit_templates therefore
--   uses RLS-only protection for its status lifecycle (no trigger), so that
--   publish_audit_template() can atomically retire the previous published version
--   without a trigger conflict.  audit_checkpoints, audit_submissions, and
--   audit_responses use triggers because no RPC mutates those tables in ways
--   that would conflict.

-- ===========================================================================
-- 1. Enum types
-- ===========================================================================

CREATE TYPE audit_template_status  AS ENUM ('draft', 'published', 'retired');
CREATE TYPE audit_submission_status AS ENUM ('in_progress', 'submitted');
CREATE TYPE audit_result            AS ENUM ('pass', 'fail', 'na');

-- ===========================================================================
-- 2. audit_templates
-- ===========================================================================

CREATE TABLE audit_templates (
  id                   uuid                  NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_key            text                  NOT NULL,   -- logical identifier, e.g. 'ssp_daily'
  version              integer               NOT NULL DEFAULT 1,
  title                text                  NOT NULL,
  description          text,
  status               audit_template_status NOT NULL DEFAULT 'draft',
  published_at         timestamptz,
  published_by_user_id uuid                  REFERENCES app_users(id),
  retired_at           timestamptz,
  created_by_user_id   uuid                  REFERENCES app_users(id),
  created_at           timestamptz           NOT NULL DEFAULT now(),
  updated_at           timestamptz           NOT NULL DEFAULT now(),

  CONSTRAINT audit_templates_audit_key_not_empty CHECK (trim(audit_key) <> ''),
  CONSTRAINT audit_templates_title_not_empty     CHECK (trim(title) <> ''),
  CONSTRAINT audit_templates_version_positive    CHECK (version >= 1)
);

-- Only one published template per audit_key at any given time.
CREATE UNIQUE INDEX audit_templates_one_published_per_key
  ON audit_templates (audit_key)
  WHERE status = 'published';

-- Fast lookup by key and version.
CREATE INDEX audit_templates_key_version
  ON audit_templates (audit_key, version DESC);

CREATE TRIGGER audit_templates_updated_at
  BEFORE UPDATE ON audit_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- 3. audit_checkpoints
-- ===========================================================================

CREATE TABLE audit_checkpoints (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id              uuid        NOT NULL REFERENCES audit_templates(id),
  sort_order               integer     NOT NULL DEFAULT 0,
  section                  text,                   -- optional grouping header
  title                    text        NOT NULL,
  description              text,
  required                 boolean     NOT NULL DEFAULT true,
  allow_na                 boolean     NOT NULL DEFAULT false,
  failure_requires_comment boolean     NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),

  -- No updated_at: checkpoints are immutable once the template is published.
  CONSTRAINT audit_checkpoints_title_not_empty CHECK (trim(title) <> '')
);

CREATE INDEX audit_checkpoints_template
  ON audit_checkpoints (template_id, sort_order ASC);

-- ===========================================================================
-- 4. audit_submissions
-- ===========================================================================

CREATE TABLE audit_submissions (
  id              uuid                    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id     uuid                    NOT NULL REFERENCES audit_templates(id),
  location_id     uuid                    NOT NULL REFERENCES locations(id),
  auditor_user_id uuid                    NOT NULL REFERENCES app_users(id),
  status          audit_submission_status NOT NULL DEFAULT 'in_progress',

  -- Scores: NULL until submit_audit() writes them.
  score_pass      integer,
  score_fail      integer,
  score_na        integer,
  score_total     integer,          -- score_pass + score_fail (na excluded)
  score_pct       numeric(5, 2),    -- score_pass / score_total * 100; NULL if score_total = 0

  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_submissions_score_pct_range
    CHECK (score_pct IS NULL OR (score_pct >= 0 AND score_pct <= 100))
);

CREATE INDEX audit_submissions_template   ON audit_submissions (template_id);
CREATE INDEX audit_submissions_location   ON audit_submissions (location_id);
CREATE INDEX audit_submissions_auditor    ON audit_submissions (auditor_user_id);
CREATE INDEX audit_submissions_open       ON audit_submissions (status)
  WHERE status = 'in_progress';

CREATE TRIGGER audit_submissions_updated_at
  BEFORE UPDATE ON audit_submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- 5. audit_responses
-- ===========================================================================

CREATE TABLE audit_responses (
  id            uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  submission_id uuid         NOT NULL REFERENCES audit_submissions(id),
  checkpoint_id uuid         NOT NULL REFERENCES audit_checkpoints(id),
  result        audit_result,          -- NULL = unanswered; pass | fail | na
  comment       text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  -- One response per checkpoint per submission.
  UNIQUE (submission_id, checkpoint_id)
);

CREATE INDEX audit_responses_submission ON audit_responses (submission_id);

CREATE TRIGGER audit_responses_updated_at
  BEFORE UPDATE ON audit_responses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================================================
-- 6. Immutability triggers
-- ===========================================================================
--
-- audit_templates has NO immutability trigger — see file header note.
-- Its status lifecycle is protected by RLS WITH CHECK (status = 'draft')
-- so authenticated users cannot promote directly; the SECURITY DEFINER RPC
-- bypasses RLS and does its own authorization before changing status.

-- 6a. audit_checkpoints — immutable once the parent template is published/retired.

CREATE OR REPLACE FUNCTION _audit_checkpoints_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_template_status audit_template_status;
BEGIN
  SELECT status INTO v_template_status
  FROM audit_templates
  WHERE id = COALESCE(OLD.template_id, NEW.template_id);

  IF v_template_status IN ('published', 'retired') THEN
    RAISE EXCEPTION
      'audit_checkpoints: checkpoints for published/retired templates are immutable (checkpoint id: %)',
      COALESCE(OLD.id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_checkpoints_guard_immutable
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION _audit_checkpoints_guard_immutable();

-- 6b. audit_submissions — two guards in one trigger:
--     i.  Submitted rows are fully immutable.
--     ii. template_id and auditor_user_id are immutable after INSERT on any row.
--
-- submit_audit() is SECURITY DEFINER and updates a row whose OLD.status is
-- 'in_progress', so guard (i) does not block it. template_id and auditor_user_id
-- are unchanged by submit_audit(), so guard (ii) does not block it either.

CREATE OR REPLACE FUNCTION _audit_submissions_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION
      'audit_submissions: submitted audits are immutable (id: %)', OLD.id;
  END IF;

  IF NEW.template_id <> OLD.template_id THEN
    RAISE EXCEPTION
      'audit_submissions: template_id is immutable after INSERT (id: %)', OLD.id;
  END IF;

  IF NEW.auditor_user_id <> OLD.auditor_user_id THEN
    RAISE EXCEPTION
      'audit_submissions: auditor_user_id is immutable after INSERT (id: %)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_submissions_guard
  BEFORE UPDATE ON audit_submissions
  FOR EACH ROW EXECUTE FUNCTION _audit_submissions_guard();

-- 6c. audit_responses — responses for submitted audits are immutable.

CREATE OR REPLACE FUNCTION _audit_responses_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_submission_status audit_submission_status;
BEGIN
  SELECT status INTO v_submission_status
  FROM audit_submissions
  WHERE id = OLD.submission_id;

  IF v_submission_status = 'submitted' THEN
    RAISE EXCEPTION
      'audit_responses: responses for submitted audits are immutable (submission id: %)',
      OLD.submission_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_responses_guard_immutable
  BEFORE UPDATE OR DELETE ON audit_responses
  FOR EACH ROW EXECUTE FUNCTION _audit_responses_guard_immutable();

-- ===========================================================================
-- 7. Row-level security
-- ===========================================================================

ALTER TABLE audit_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_submissions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_responses    ENABLE ROW LEVEL SECURITY;

-- ── audit_templates ──────────────────────────────────────────────────────────

-- Management (SA/UM) can see all statuses including draft.
CREATE POLICY "audit_templates: management can read all"
  ON audit_templates FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Members can read published and retired templates (for audit execution).
CREATE POLICY "audit_templates: member can read published or retired"
  ON audit_templates FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND status IN ('published', 'retired')
  );

-- Management can create draft templates only.
CREATE POLICY "audit_templates: management can insert"
  ON audit_templates FOR INSERT
  TO authenticated
  WITH CHECK (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND status = 'draft'
  );

-- Management can edit draft templates only.
-- USING (status = 'draft') blocks access to published/retired rows for UPDATE.
-- WITH CHECK (status = 'draft') prevents direct status promotion out of draft.
-- Publishing/retiring must go through publish_audit_template() (SECURITY DEFINER).
CREATE POLICY "audit_templates: management can update draft"
  ON audit_templates FOR UPDATE
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM') AND status = 'draft')
  WITH CHECK (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND status = 'draft'
  );

-- No DELETE policy — soft lifecycle via status column only.

-- ── audit_checkpoints ────────────────────────────────────────────────────────

-- Management can read all checkpoints.
CREATE POLICY "audit_checkpoints: management can read all"
  ON audit_checkpoints FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Members can read checkpoints for published/retired templates.
CREATE POLICY "audit_checkpoints: member can read published or retired"
  ON audit_checkpoints FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND (SELECT status FROM audit_templates WHERE id = template_id) IN ('published', 'retired')
  );

-- Management can insert checkpoints on draft templates only.
CREATE POLICY "audit_checkpoints: management can insert on draft"
  ON audit_checkpoints FOR INSERT
  TO authenticated
  WITH CHECK (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND (SELECT status FROM audit_templates WHERE id = template_id) = 'draft'
  );

-- Management can update checkpoints on draft templates.
-- Trigger _audit_checkpoints_guard_immutable provides a second layer of protection.
CREATE POLICY "audit_checkpoints: management can update on draft"
  ON audit_checkpoints FOR UPDATE
  TO authenticated
  USING (
    get_my_role() IN ('SUPER_ADMIN', 'UM')
    AND (SELECT status FROM audit_templates WHERE id = template_id) = 'draft'
  )
  WITH CHECK (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- No DELETE policy.

-- ── audit_submissions ────────────────────────────────────────────────────────

-- Auditor can read their own submissions (all statuses).
CREATE POLICY "audit_submissions: auditor can read own"
  ON audit_submissions FOR SELECT
  TO authenticated
  USING (auditor_user_id = get_my_app_user_id());

-- Management can read all submissions across all locations.
CREATE POLICY "audit_submissions: management can read all"
  ON audit_submissions FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Auditor can start a new submission only when:
--   • auditor_user_id is themselves
--   • the template is currently published
--   • the location is active
CREATE POLICY "audit_submissions: auditor can insert"
  ON audit_submissions FOR INSERT
  TO authenticated
  WITH CHECK (
    auditor_user_id = get_my_app_user_id()
    AND status = 'in_progress'
    AND (SELECT status FROM audit_templates WHERE id = template_id) = 'published'
    AND (SELECT active FROM locations WHERE id = location_id) = true
  );

-- Auditor can update their own in_progress submissions.
-- template_id and auditor_user_id immutability is enforced by trigger.
-- Scores and submitted_at are set only by submit_audit() (SECURITY DEFINER).
CREATE POLICY "audit_submissions: auditor can update in_progress"
  ON audit_submissions FOR UPDATE
  TO authenticated
  USING (auditor_user_id = get_my_app_user_id() AND status = 'in_progress')
  WITH CHECK (auditor_user_id = get_my_app_user_id());

-- No DELETE policy.

-- ── audit_responses ──────────────────────────────────────────────────────────

-- Auditor can read responses on their own submissions.
CREATE POLICY "audit_responses: auditor can read own"
  ON audit_responses FOR SELECT
  TO authenticated
  USING (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
    )
  );

-- Management can read all responses.
CREATE POLICY "audit_responses: management can read all"
  ON audit_responses FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Auditor can insert responses on their own in_progress submissions.
CREATE POLICY "audit_responses: auditor can insert"
  ON audit_responses FOR INSERT
  TO authenticated
  WITH CHECK (
    submission_id IN (
      SELECT id FROM audit_submissions
      WHERE auditor_user_id = get_my_app_user_id()
        AND status = 'in_progress'
    )
  );

-- Auditor can update responses on their own in_progress submissions.
-- Submitted responses are also blocked by trigger _audit_responses_guard_immutable.
CREATE POLICY "audit_responses: auditor can update"
  ON audit_responses FOR UPDATE
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

-- No DELETE policy.

-- ===========================================================================
-- 8. SECURITY DEFINER RPCs
-- ===========================================================================

-- ── publish_audit_template ───────────────────────────────────────────────────
--
-- Atomically:
--   1. Validates actor is SA/UM.
--   2. Validates template is currently draft.
--   3. Retires any existing published version of the same audit_key.
--   4. Sets the target template to published.
--   5. Writes audit_events for retire (if applicable) and publish.
--
-- Bypasses RLS (SECURITY DEFINER). Performs explicit authorization before
-- making any changes. Does not conflict with triggers because
-- _audit_templates_guard_immutable does not exist (see file header note).

CREATE OR REPLACE FUNCTION publish_audit_template(
  p_template_id   uuid,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_actor_role kk_role;
  v_template   RECORD;
  v_retired_id uuid;
BEGIN
  -- Authorise actor
  SELECT role INTO v_actor_role
  FROM app_users
  WHERE id = p_actor_user_id AND active = true;

  IF NOT FOUND OR v_actor_role NOT IN ('SUPER_ADMIN', 'UM') THEN
    RAISE EXCEPTION 'Not authorised: SUPER_ADMIN or UM required to publish audit templates';
  END IF;

  -- Lock and fetch target template
  SELECT id, audit_key, version, status
  INTO v_template
  FROM audit_templates
  WHERE id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit template not found: %', p_template_id;
  END IF;

  IF v_template.status <> 'draft' THEN
    RAISE EXCEPTION
      'Only draft templates can be published (template id: %, current status: %)',
      p_template_id, v_template.status;
  END IF;

  -- Atomically retire any existing published version of the same audit_key
  UPDATE audit_templates
  SET
    status     = 'retired',
    retired_at = now(),
    updated_at = now()
  WHERE audit_key = v_template.audit_key
    AND status    = 'published'
    AND id        <> p_template_id
  RETURNING id INTO v_retired_id;

  IF v_retired_id IS NOT NULL THEN
    INSERT INTO audit_events (
      actor_user_id, actor_type, action, entity_type, entity_id,
      before_json, after_json
    )
    VALUES (
      p_actor_user_id, 'human',
      'audit_template.retired', 'audit_template', v_retired_id,
      jsonb_build_object('status', 'published'),
      jsonb_build_object('status', 'retired', 'retired_at', now())
    );
  END IF;

  -- Publish the target template
  UPDATE audit_templates
  SET
    status               = 'published',
    published_at         = now(),
    published_by_user_id = p_actor_user_id,
    updated_at           = now()
  WHERE id = p_template_id;

  INSERT INTO audit_events (
    actor_user_id, actor_type, action, entity_type, entity_id,
    before_json, after_json
  )
  VALUES (
    p_actor_user_id, 'human',
    'audit_template.published', 'audit_template', p_template_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object(
      'status',       'published',
      'audit_key',    v_template.audit_key,
      'version',      v_template.version,
      'published_at', now()
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION publish_audit_template(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION publish_audit_template(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION publish_audit_template(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION publish_audit_template(uuid, uuid) TO service_role;

-- ── submit_audit ─────────────────────────────────────────────────────────────
--
-- Validates a completed audit submission and writes its final state atomically.
--
-- Validation:
--   • Actor must be the auditor on record or SA/UM.
--   • Submission must be in_progress.
--   • Template must not be draft (published or retired are both acceptable).
--   • All required checkpoints must have a non-NULL result.
--   • N/A results are only allowed on checkpoints with allow_na = true.
--   • Fail results on checkpoints with failure_requires_comment = true must
--     have a non-empty comment.
--
-- Scoring:
--   • score_pass   = count of pass responses
--   • score_fail   = count of fail responses
--   • score_na     = count of na responses (excluded from denominator)
--   • score_total  = score_pass + score_fail
--   • score_pct    = round(score_pass / score_total * 100, 2); NULL if score_total = 0
--
-- All score columns, status, and submitted_at are written only here.
-- _audit_submissions_guard does not block this call: OLD.status is 'in_progress'
-- and template_id / auditor_user_id are unchanged.

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
  v_score_pass      integer := 0;
  v_score_fail      integer := 0;
  v_score_na        integer := 0;
  v_score_total     integer;
  v_score_pct       numeric(5, 2);
BEGIN
  -- Resolve actor role
  SELECT role INTO v_actor_role
  FROM app_users
  WHERE id = p_actor_user_id AND active = true;

  -- Lock and fetch submission
  SELECT id, template_id, auditor_user_id, status
  INTO v_submission
  FROM audit_submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit submission not found: %', p_submission_id;
  END IF;

  -- Authorise: must be the auditor or management
  IF v_submission.auditor_user_id <> p_actor_user_id
     AND (v_actor_role IS NULL OR v_actor_role NOT IN ('SUPER_ADMIN', 'UM')) THEN
    RAISE EXCEPTION
      'Not authorised: only the auditor or management may submit this audit (submission: %)',
      p_submission_id;
  END IF;

  IF v_submission.status <> 'in_progress' THEN
    RAISE EXCEPTION
      'Only in_progress submissions can be submitted (current status: %)',
      v_submission.status;
  END IF;

  -- Validate template is not draft
  SELECT status INTO v_template_status
  FROM audit_templates
  WHERE id = v_submission.template_id;

  IF v_template_status = 'draft' THEN
    RAISE EXCEPTION
      'Cannot submit an audit against a draft template (template id: %)',
      v_submission.template_id;
  END IF;

  -- Validate each checkpoint
  FOR v_checkpoint IN
    SELECT id, required, allow_na, failure_requires_comment
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

      -- Failed checkpoints requiring a comment must have one
      IF v_response.result = 'fail'
         AND v_checkpoint.failure_requires_comment
         AND (v_response.comment IS NULL OR trim(v_response.comment) = '') THEN
        RAISE EXCEPTION
          'Failed checkpoint % requires a comment (submission: %)',
          v_checkpoint.id, p_submission_id;
      END IF;
    END IF;
  END LOOP;

  -- Compute scores (na excluded from denominator)
  SELECT
    COUNT(*) FILTER (WHERE result = 'pass')::integer,
    COUNT(*) FILTER (WHERE result = 'fail')::integer,
    COUNT(*) FILTER (WHERE result = 'na')::integer
  INTO v_score_pass, v_score_fail, v_score_na
  FROM audit_responses
  WHERE submission_id = p_submission_id;

  v_score_total := v_score_pass + v_score_fail;
  v_score_pct   := CASE
    WHEN v_score_total > 0
    THEN round((v_score_pass::numeric / v_score_total) * 100, 2)
    ELSE NULL
  END;

  -- Write final state atomically
  UPDATE audit_submissions
  SET
    status       = 'submitted',
    score_pass   = v_score_pass,
    score_fail   = v_score_fail,
    score_na     = v_score_na,
    score_total  = v_score_total,
    score_pct    = v_score_pct,
    submitted_at = now(),
    updated_at   = now()
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
      'status',       'submitted',
      'score_pass',   v_score_pass,
      'score_fail',   v_score_fail,
      'score_na',     v_score_na,
      'score_total',  v_score_total,
      'score_pct',    v_score_pct,
      'submitted_at', now()
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_audit(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_audit(uuid, uuid) TO service_role;
