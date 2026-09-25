-- 20260925130000_airport_kqc_native.sql
--
-- Phase 1: Native CPH Airport KQC template in the shared audit engine.
--
-- Changes:
--
-- 1. scoring_config JSONB on audit_templates — protocol-specific metric labels
--    and status behaviour so the UI/reports render the right terminology.
--
-- 2. Seed ssp_cph_kqc template (58 checkpoints, 15 Critical) using the exact
--    current production Config tab.
--
-- The existing Google Sheet pipeline is untouched. This creates a parallel
-- native template that can be used for new visits once the UI is wired.
--
-- Scoring reuse:
--   Airport "Critical" → is_core_standard = true (the generic secondary-subset flag)
--   Airport has no Red Flag concept → is_red_flag = false on all checkpoints
--   core_score_pct  = Critical Score
--   core_score_fail = Critical Failures
--   The scoring_config labels tell the UI what to call these metrics.

-- ===========================================================================
-- 1. scoring_config on audit_templates
-- ===========================================================================

ALTER TABLE audit_templates
  ADD COLUMN scoring_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Set Operational Audit scoring config
UPDATE audit_templates
SET scoring_config = jsonb_build_object(
  'secondary_label',        'Core Standards',
  'secondary_short',        'Core',
  'secondary_fail_label',   'Red Flags',
  'secondary_fail_short',   'RF',
  'has_red_flags',          true,
  'rf_overrides_status',    true,
  'rf_badge_style',         'red_flag'
)
WHERE audit_key = 'operational_audit';

-- ===========================================================================
-- 2. Seed CPH Airport KQC template
-- ===========================================================================

DO $$
DECLARE
  v_template_id uuid;
  v_sort integer := 0;
BEGIN

  INSERT INTO audit_templates (
    audit_key, version, title, description, status,
    published_at, published_by_user_id,
    requires_busyness, requires_failure_context, requires_manager_on_duty,
    scoring_config
  )
  VALUES (
    'ssp_cph_kqc', 1, 'CPH Airport KQC', 'Killer Kuality Check — SSP / CPH Airport',
    'published', now(), NULL,
    true, true, false,
    jsonb_build_object(
      'secondary_label',        'Critical',
      'secondary_short',        'Critical',
      'secondary_fail_label',   'Critical Failures',
      'secondary_fail_short',   'CF',
      'has_red_flags',          false,
      'rf_overrides_status',    false,
      'rf_badge_style',         'critical'
    )
  )
  RETURNING id INTO v_template_id;

  -- ── Prep / Operations (6 checkpoints, ALL Critical) ──────────────────────

  v_sort := 100;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1, 'Prep / Operations', 'Prep correctly dated and within date / fresh',                  true, false, false, true, false),
  (v_template_id, v_sort + 2, 'Prep / Operations', 'Meat weighed using scale',                                      true, false, false, true, false),
  (v_template_id, v_sort + 3, 'Prep / Operations', 'Meat holding temperature',                                      true, false, false, true, false),
  (v_template_id, v_sort + 4, 'Prep / Operations', 'Lid used correctly',                                            true, false, false, true, false),
  (v_template_id, v_sort + 5, 'Prep / Operations', 'Blade properly sharp / cut straight with no mushrooming',       true, false, false, true, false),
  (v_template_id, v_sort + 6, 'Prep / Operations', 'Bread baked fresh to order',                                    true, false, false, true, false);

  -- ── Service / Staff (4 checkpoints, 1 Critical) ─────────────────────────

  v_sort := 200;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1, 'Service / Staff', 'All staff in uniform',              true, false, false, true,  false),
  (v_template_id, v_sort + 2, 'Service / Staff', 'Eye contact when ordering',         true, false, false, false, false),
  (v_template_id, v_sort + 3, 'Service / Staff', 'Eye contact at pickup',             true, false, false, false, false),
  (v_template_id, v_sort + 4, 'Service / Staff', 'Verbal interaction at pickup',      true, false, false, false, false);

  -- ── Fries (4 checkpoints, 1 Critical) ───────────────────────────────────

  v_sort := 300;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1, 'Fries', 'Warm',           true, false, false, true,  false),
  (v_template_id, v_sort + 2, 'Fries', 'Crispy',         true, false, false, false, false),
  (v_template_id, v_sort + 3, 'Fries', 'Salt',           true, false, false, false, false),
  (v_template_id, v_sort + 4, 'Fries', 'Dukkah present', true, false, false, false, false);

  -- ── Kebab Wrap (12 checkpoints, 2 Critical) ─────────────────────────────

  v_sort := 400;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1,  'Kebab Wrap', 'Meat temperature',           true, false, false, true,  false),
  (v_template_id, v_sort + 2,  'Kebab Wrap', 'Bread temperature',          true, false, false, true,  false),
  (v_template_id, v_sort + 3,  'Kebab Wrap', 'Bread fluffiness',           true, false, false, false, false),
  (v_template_id, v_sort + 4,  'Kebab Wrap', 'Bread caramelisation',       true, false, false, false, false),
  (v_template_id, v_sort + 5,  'Kebab Wrap', 'Meat caramelisation',        true, false, false, false, false),
  (v_template_id, v_sort + 6,  'Kebab Wrap', 'Meat texture / juiciness',   true, false, false, false, false),
  (v_template_id, v_sort + 7,  'Kebab Wrap', 'Distribution',               true, false, false, false, false),
  (v_template_id, v_sort + 8,  'Kebab Wrap', 'Mint yoghurt sauce',         true, false, false, false, false),
  (v_template_id, v_sort + 9,  'Kebab Wrap', 'Parsley',                    true, false, false, false, false),
  (v_template_id, v_sort + 10, 'Kebab Wrap', 'Onion',                      true, false, false, false, false),
  (v_template_id, v_sort + 11, 'Kebab Wrap', 'Dukkah',                     true, false, false, false, false),
  (v_template_id, v_sort + 12, 'Kebab Wrap', 'Harissa',                    true, false, false, false, false);

  -- ── Chicken Wrap (12 checkpoints, 2 Critical) ──────────────────────────

  v_sort := 500;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1,  'Chicken Wrap', 'Chicken temperature',           true, false, false, true,  false),
  (v_template_id, v_sort + 2,  'Chicken Wrap', 'Bread temperature',             true, false, false, true,  false),
  (v_template_id, v_sort + 3,  'Chicken Wrap', 'Bread fluffiness',              true, false, false, false, false),
  (v_template_id, v_sort + 4,  'Chicken Wrap', 'Bread caramelisation',          true, false, false, false, false),
  (v_template_id, v_sort + 5,  'Chicken Wrap', 'Chicken caramelisation',        true, false, false, false, false),
  (v_template_id, v_sort + 6,  'Chicken Wrap', 'Chicken texture / juiciness',   true, false, false, false, false),
  (v_template_id, v_sort + 7,  'Chicken Wrap', 'Distribution',                  true, false, false, false, false),
  (v_template_id, v_sort + 8,  'Chicken Wrap', 'Zhugurt',                       true, false, false, false, false),
  (v_template_id, v_sort + 9,  'Chicken Wrap', 'Parsley',                       true, false, false, false, false),
  (v_template_id, v_sort + 10, 'Chicken Wrap', 'Killer Cucumbers',              true, false, false, false, false),
  (v_template_id, v_sort + 11, 'Chicken Wrap', 'Cabbage',                       true, false, false, false, false),
  (v_template_id, v_sort + 12, 'Chicken Wrap', 'Harissa',                       true, false, false, false, false);

  -- ── Falafel Wrap (12 checkpoints, 2 Critical) ──────────────────────────

  v_sort := 600;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1,  'Falafel Wrap', 'Falafel hot and fully cooked',  true, false, false, true,  false),
  (v_template_id, v_sort + 2,  'Falafel Wrap', 'Bread temperature',             true, false, false, true,  false),
  (v_template_id, v_sort + 3,  'Falafel Wrap', 'Bread fluffiness',              true, false, false, false, false),
  (v_template_id, v_sort + 4,  'Falafel Wrap', 'Bread caramelisation',          true, false, false, false, false),
  (v_template_id, v_sort + 5,  'Falafel Wrap', 'Falafel consistency',           true, false, false, false, false),
  (v_template_id, v_sort + 6,  'Falafel Wrap', 'Falafel size',                  true, false, false, false, false),
  (v_template_id, v_sort + 7,  'Falafel Wrap', 'Distribution',                  true, false, false, false, false),
  (v_template_id, v_sort + 8,  'Falafel Wrap', 'Apple',                         true, false, false, false, false),
  (v_template_id, v_sort + 9,  'Falafel Wrap', 'Mint',                          true, false, false, false, false),
  (v_template_id, v_sort + 10, 'Falafel Wrap', 'Truffle mayo',                  true, false, false, false, false),
  (v_template_id, v_sort + 11, 'Falafel Wrap', 'Cabbage',                       true, false, false, false, false),
  (v_template_id, v_sort + 12, 'Falafel Wrap', 'Harissa',                       true, false, false, false, false);

  -- ── Falafel Cup (6 checkpoints, 1 Critical) ────────────────────────────

  v_sort := 700;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1, 'Falafel Cup', 'Falafel hot and fully cooked', true, false, false, true,  false),
  (v_template_id, v_sort + 2, 'Falafel Cup', 'Falafel consistency',          true, false, false, false, false),
  (v_template_id, v_sort + 3, 'Falafel Cup', 'Falafel size',                 true, false, false, false, false),
  (v_template_id, v_sort + 4, 'Falafel Cup', 'Quantity — 3 falafels',        true, false, false, false, false),
  (v_template_id, v_sort + 5, 'Falafel Cup', 'Truffle dip',                  true, false, false, false, false),
  (v_template_id, v_sort + 6, 'Falafel Cup', 'Dip amount',                   true, false, false, false, false);

  -- ── Lemonade (2 checkpoints, 0 Critical) ───────────────────────────────

  v_sort := 800;

  INSERT INTO audit_checkpoints (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag) VALUES
  (v_template_id, v_sort + 1, 'Lemonade', 'Available', true, false, false, false, false),
  (v_template_id, v_sort + 2, 'Lemonade', 'Taste',     true, false, false, false, false);

  -- ── Verify counts ──────────────────────────────────────────────────────

  PERFORM 1 FROM audit_checkpoints WHERE template_id = v_template_id
  HAVING COUNT(*) = 58 AND COUNT(*) FILTER (WHERE is_core_standard) = 15;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Airport KQC seed verification failed: expected 58 total / 15 critical';
  END IF;

END $$;
