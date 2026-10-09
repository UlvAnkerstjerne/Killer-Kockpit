-- Paid Strategy: autonomous execution. File only: applying this migration is a separate, explicitly approved step.
--
-- Evolves marketing_paid_strategy_implementations from a task-first record into an execution state machine:
-- Kockpit does the digital work itself and stops only at a genuine blocker. The v1 foundation (approval,
-- audit, exactly-once claim, shared budget reservation) is kept and reused unchanged in spirit.
--
--   modes   platform_action | tracking_execution | creative_execution | campaign_creation | needs_input
--   status  prepared, needs_input, approved -> planning -> executing -> verifying
--           -> waiting_for_input | waiting_for_access | ready_to_activate -> in_motion -> completed
--           (+ cancelled, needs_attention, failed). 'started' is kept for rows created by v1.
--   execution  the step ledger: what was created where (Meta ids, server-side only), blockers, evidence.

-- Drop the three v1 CHECKs that this migration widens. They are matched by what they constrain (Postgres stores
-- `x IN (...)` as `x = ANY (ARRAY[...])`), so the match does not depend on auto-generated constraint names.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.marketing_paid_strategy_implementations'::regclass AND contype = 'c'
             AND (pg_get_constraintdef(oid) LIKE 'CHECK ((implementation_mode = ANY%'
               OR pg_get_constraintdef(oid) LIKE 'CHECK ((status = ANY%'
               OR pg_get_constraintdef(oid) LIKE '%approved_at IS NOT NULL%')
  LOOP EXECUTE format('ALTER TABLE public.marketing_paid_strategy_implementations DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;

ALTER TABLE public.marketing_paid_strategy_implementations
  ADD CONSTRAINT paid_strategy_implementation_mode_check CHECK (implementation_mode IN (
    'platform_action','tracking_execution','creative_execution','campaign_creation','needs_input',
    'implementation_task','creative_task','implementation_package')),
  ADD CONSTRAINT paid_strategy_implementation_status_check CHECK (status IN (
    'prepared','needs_input','approved','planning','executing','verifying','waiting_for_input','waiting_for_access',
    'ready_to_activate','started','in_motion','completed','cancelled','needs_attention','failed')),
  ADD CONSTRAINT paid_strategy_implementation_approved_check CHECK (
    status IN ('prepared','needs_input','cancelled','failed') OR approved_at IS NOT NULL),
  ADD COLUMN execution jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(execution) = 'object' AND octet_length(execution::text) <= 200000);

-- A reservation is held by everything in flight, including work that is waiting on a person or ready to activate.
-- It is released by completed / cancelled / failed, or when a linked task is done or cancelled.
CREATE OR REPLACE FUNCTION public.paid_strategy_reserved_dkk(p_exclude uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(i.budget_reserved_dkk), 0)
  FROM public.marketing_paid_strategy_implementations i
  WHERE i.status IN ('approved','planning','executing','verifying','waiting_for_input','waiting_for_access','ready_to_activate','started','in_motion','needs_attention')
    AND (p_exclude IS NULL OR i.id <> p_exclude)
    AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = i.linked_task_id AND t.status::text IN ('done','cancelled'));
$$;

-- Same exactly-once, latest-run and shared-headroom admission as v1, with the new execution modes.
CREATE OR REPLACE FUNCTION public.approve_paid_strategy_implementation(
  p_run_id uuid, p_index smallint, p_actor uuid, p_mode text, p_budget numeric, p_inputs jsonb, p_compiled jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_latest uuid; v_row public.marketing_paid_strategy_implementations%ROWTYPE;
  v_reliable boolean; v_headroom numeric; v_reserved numeric; v_available numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('paid_strategy_budget_reservation'));
  IF p_mode NOT IN ('platform_action','tracking_execution','creative_execution','campaign_creation') THEN
    RETURN jsonb_build_object('result','invalid_mode');
  END IF;
  IF p_budget IS NULL OR p_budget < 0 THEN RETURN jsonb_build_object('result','invalid_budget'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users u WHERE u.id = p_actor AND u.active) THEN
    RETURN jsonb_build_object('result','actor_inactive');
  END IF;

  SELECT id INTO v_latest FROM public.marketing_paid_strategy_runs WHERE status = 'completed' ORDER BY generated_at DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_run_id THEN RETURN jsonb_build_object('result','superseded'); END IF;

  SELECT * INTO v_row FROM public.marketing_paid_strategy_implementations
   WHERE strategy_run_id = p_run_id AND recommendation_index = p_index FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_prepared'); END IF;
  -- Only prepared, input-needing or cleanly failed (nothing created externally) can be claimed. Everything else is in flight or done.
  IF v_row.status NOT IN ('prepared','needs_input','failed') OR (v_row.status = 'failed' AND (v_row.linked_task_id IS NOT NULL OR v_row.execution -> 'steps' @> '[{"status":"done"}]'::jsonb)) THEN
    RETURN jsonb_build_object('result','already_claimed','status',v_row.status,'id',v_row.id);
  END IF;

  v_reserved := public.paid_strategy_reserved_dkk(v_row.id);
  SELECT COALESCE((r.evidence #>> '{budget,projection,reliable}')::boolean, false),
         NULLIF(r.evidence #>> '{budget,projection,projected_incremental_headroom}', '')::numeric
    INTO v_reliable, v_headroom FROM public.marketing_paid_strategy_runs r WHERE r.id = p_run_id;
  v_available := CASE WHEN v_reliable AND v_headroom IS NOT NULL THEN GREATEST(0, v_headroom - v_reserved) END;
  IF p_budget > 0 THEN
    IF v_available IS NULL THEN RETURN jsonb_build_object('result','headroom_unreliable'); END IF;
    IF p_budget > v_available THEN RETURN jsonb_build_object('result','exceeds_headroom','available',v_available); END IF;
  END IF;

  UPDATE public.marketing_paid_strategy_implementations SET
    status = 'approved', implementation_mode = p_mode, inputs = COALESCE(p_inputs,'{}'), compiled = COALESCE(p_compiled,'{}'),
    budget_reserved_dkk = p_budget, approved_by_user_id = p_actor, approved_at = now(), error = NULL, result = NULL, updated_at = now()
   WHERE id = v_row.id;
  INSERT INTO public.audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (p_actor, 'human', 'marketing.paid_strategy_implementation.approved', 'paid_strategy_implementation', v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('strategy_run_id', p_run_id, 'recommendation_index', p_index, 'mode', p_mode, 'budget_reserved_dkk', p_budget));
  RETURN jsonb_build_object('result','claimed','id',v_row.id,'available',v_available);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.paid_strategy_reserved_dkk(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_paid_strategy_implementation(uuid, smallint, uuid, text, numeric, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paid_strategy_reserved_dkk(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_paid_strategy_implementation(uuid, smallint, uuid, text, numeric, jsonb, jsonb) TO service_role;

-- The minimum reusable creative artifact. Not a Creative Studio: one draft per implementation, readable by Paid Strategy readers.
CREATE TABLE public.marketing_paid_strategy_creative_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  implementation_id uuid NOT NULL UNIQUE REFERENCES public.marketing_paid_strategy_implementations(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  campaign_name text CHECK (length(campaign_name) <= 200),
  angle text NOT NULL CHECK (length(angle) <= 600),
  primary_text text NOT NULL CHECK (length(primary_text) <= 3000),
  headline text NOT NULL CHECK (length(headline) <= 200),
  description text NOT NULL CHECK (length(description) <= 300),
  cta text NOT NULL CHECK (cta IN ('SEE_MENU','LEARN_MORE','GET_QUOTE','CONTACT_US','SIGN_UP','ORDER_NOW')),
  hook_options jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(hook_options) = 'array' AND jsonb_array_length(hook_options) <= 5),
  script text CHECK (length(script) <= 3000),
  shot_list jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(shot_list) = 'array' AND jsonb_array_length(shot_list) <= 8),
  test_design jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(test_design) = 'object' AND octet_length(test_design::text) <= 20000),
  asset_state text NOT NULL DEFAULT 'existing_images' CHECK (asset_state IN ('existing_images','needs_new_footage')),
  approval_state text NOT NULL DEFAULT 'pending_review' CHECK (approval_state IN ('pending_review','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.marketing_paid_strategy_creative_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_paid_strategy_creative_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.marketing_paid_strategy_creative_drafts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.marketing_paid_strategy_creative_drafts TO service_role;
CREATE POLICY paid_strategy_creative_drafts_read ON public.marketing_paid_strategy_creative_drafts FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));

COMMENT ON COLUMN public.marketing_paid_strategy_implementations.execution IS
  'Step ledger: which external objects were created (Meta ids stay server-side), blockers, and evidence. Resuming reads it so nothing is created twice.';
