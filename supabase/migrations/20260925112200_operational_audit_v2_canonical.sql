-- 20260925140000_operational_audit_v2_canonical.sql
--
-- Restores the Operational Audit to the canonical 98/43/15 specification.
--
-- v1 (100 checkpoints, 44 Core Standards, 15 Red Flags) included two
-- post-seed additions that are not part of the approved canonical protocol:
--   1. "Egenkontrol is updated and maintained." (Operational Compliance, Core)
--   2. "The top heater is turned off when not needed to cook the kebab." (Prep/Ops)
--
-- v1 has completed submissions referencing it (2 submitted, 2 in-progress).
-- Those submissions and their responses are preserved exactly as-is.
-- v1 will be retired (not deleted) when v2 is published.
--
-- v2 is created as an exact copy of v1's 98 canonical checkpoints,
-- excluding the two non-canonical additions. All other checkpoint wording,
-- ordering, classifications, and flags are identical.
--
-- The publish_audit_template() RPC atomically retires v1 and publishes v2.

DO $$
DECLARE
  v_old_id    uuid := '88895664-0bba-402a-a92e-e4694997f3a6';
  v_new_id    uuid;
  v_actor_id  uuid;
  v_old_config jsonb;
BEGIN

  -- Get the existing scoring_config + template config to copy to v2
  SELECT scoring_config INTO v_old_config FROM audit_templates WHERE id = v_old_id;

  -- Resolve an active SUPER_ADMIN for the publish action
  SELECT id INTO v_actor_id FROM app_users WHERE role = 'SUPER_ADMIN' AND active = true LIMIT 1;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'No active SUPER_ADMIN found for template publish';
  END IF;

  -- Create v2 as draft
  INSERT INTO audit_templates (
    audit_key, version, title, description, status,
    requires_busyness, requires_failure_context, requires_manager_on_duty,
    scoring_config
  )
  VALUES (
    'operational_audit', 2, 'Master Operational Audit',
    'Canonical 98-checkpoint protocol — v2 (removes 2 non-canonical additions from v1)',
    'draft',
    true, true, true,
    v_old_config
  )
  RETURNING id INTO v_new_id;

  -- Copy all 98 canonical checkpoints (exclude the two non-canonical ones)
  INSERT INTO audit_checkpoints (
    template_id, sort_order, section, title,
    required, allow_na, failure_requires_comment,
    is_core_standard, is_red_flag
  )
  SELECT
    v_new_id, sort_order, section, title,
    required, allow_na, failure_requires_comment,
    is_core_standard, is_red_flag
  FROM audit_checkpoints
  WHERE template_id = v_old_id
    AND title NOT IN (
      'Egenkontrol is updated and maintained.',
      'The top heater is turned off when not needed to cook the kebab.'
    )
  ORDER BY sort_order;

  -- Verify canonical counts before publishing
  PERFORM 1 FROM audit_checkpoints WHERE template_id = v_new_id
  HAVING COUNT(*) = 98
     AND COUNT(*) FILTER (WHERE is_core_standard) = 43
     AND COUNT(*) FILTER (WHERE is_red_flag) = 15;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical verification failed: expected 98 total / 43 core / 15 RF';
  END IF;

  -- Atomically retire v1 and publish v2
  PERFORM publish_audit_template(v_new_id, v_actor_id);

END $$;
