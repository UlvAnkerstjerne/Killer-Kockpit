-- 20260923000000_audit_add_egenkontrol_and_top_heater.sql
--
-- Adds two new checkpoints to the published operational_audit template:
--
--   1. Egenkontrol updated and maintained
--      Section: Operational Compliance  |  sort_order: 1110
--      Core Standard: true  (mandatory legal requirement under Danish food safety law)
--      N/A permitted: true
--
--   2. The top heater is turned off when not needed to cook the kebab.
--      Section: Prep / Operations  |  sort_order: 713
--      Core Standard: false
--      N/A permitted: true  (N/A for locations without a kebab cooking setup)
--
-- Both checkpoints are inserted directly into the existing published template.
-- Scoring, the questionnaire UI, and the PDF report all derive from DB rows —
-- no application code changes are required.

DO $$
DECLARE
  v_template_id uuid;
BEGIN

  SELECT id INTO v_template_id
  FROM audit_templates
  WHERE audit_key = 'operational_audit'
    AND status     = 'published'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'Published operational_audit template not found — cannot add checkpoints.';
  END IF;

  -- ── 1. Egenkontrol ────────────────────────────────────────────────────────
  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 1110, 'Operational Compliance',
     'Egenkontrol is updated and maintained.',
     true, true, false, true, false);

  -- ── 2. Top heater ─────────────────────────────────────────────────────────
  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 713, 'Prep / Operations',
     'The top heater is turned off when not needed to cook the kebab.',
     true, true, false, false, false);

END;
$$;
