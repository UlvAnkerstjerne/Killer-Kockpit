-- Paid Strategy: implementation tracking. File only: applying this migration is a separate release step.
--
-- A Paid Strategy recommendation is advisory text inside marketing_paid_strategy_runs.recommendations and has
-- no row of its own. This table gives each (run, recommendation) ONE implementation state, so a double click,
-- a retry or two approvers can never create two tasks, reserve budget twice or run a mutation twice.
--
-- The AI never writes here. The server compiles an implementation from the stored recommendation plus synced
-- Meta structure, and approval happens through approve_paid_strategy_implementation(), which is atomic.
CREATE TABLE public.marketing_paid_strategy_implementations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_run_id uuid NOT NULL REFERENCES public.marketing_paid_strategy_runs(id) ON DELETE RESTRICT,
  recommendation_index smallint NOT NULL CHECK (recommendation_index BETWEEN 0 AND 2),
  -- The advice exactly as it was when the implementation was prepared (the run row is the source of truth; this is the audit copy).
  recommendation_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(recommendation_snapshot) = 'object' AND octet_length(recommendation_snapshot::text) <= 30000),
  implementation_mode text NOT NULL
    CHECK (implementation_mode IN ('platform_action','implementation_task','creative_task','implementation_package','needs_input')),
  -- prepared: compiled and shown, nothing has happened. approved: claimed atomically, side effect in flight.
  -- started: work handed to people (task created). in_motion: a platform change is applied and monitored.
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared','needs_input','approved','started','in_motion','completed','cancelled','needs_attention','failed')),
  -- What a person supplied (owner, due date, reserved budget, platform target choice). Never AI output.
  inputs jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(inputs) = 'object' AND octet_length(inputs::text) <= 20000),
  -- Task draft, launch package, or the trusted Meta execution plan the server compiled.
  compiled jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(compiled) = 'object' AND octet_length(compiled::text) <= 100000),
  -- Incremental paid-media budget (DKK) set aside for this implementation against the shared strategy headroom.
  budget_reserved_dkk numeric(12,2) NOT NULL DEFAULT 0 CHECK (budget_reserved_dkk >= 0 AND budget_reserved_dkk <= 15000),
  linked_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  -- Platform before/after read-back, or other outcome details. No secrets.
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 50000)),
  error text CHECK (length(error) <= 500),
  prepared_by_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  approved_by_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paid_strategy_implementation_once UNIQUE (strategy_run_id, recommendation_index),
  CHECK (status NOT IN ('approved','started','in_motion','completed','needs_attention') OR (approved_at IS NOT NULL)),
  CHECK (status NOT IN ('prepared','needs_input') OR budget_reserved_dkk = 0)
);
CREATE INDEX paid_strategy_implementations_status_idx ON public.marketing_paid_strategy_implementations(status);
CREATE INDEX paid_strategy_implementations_task_idx ON public.marketing_paid_strategy_implementations(linked_task_id) WHERE linked_task_id IS NOT NULL;
CREATE INDEX paid_strategy_implementations_prepared_by_idx ON public.marketing_paid_strategy_implementations(prepared_by_user_id);
CREATE INDEX paid_strategy_implementations_approved_by_idx ON public.marketing_paid_strategy_implementations(approved_by_user_id);

ALTER TABLE public.marketing_paid_strategy_implementations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_paid_strategy_implementations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.marketing_paid_strategy_implementations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.marketing_paid_strategy_implementations TO service_role;

-- Same read access as Paid Strategy itself: active SUPER_ADMIN, or workspace access + paid_manage.
-- No user-JWT writes; server actions authorize paid_manage / paid_approve before service_role is used.
CREATE POLICY paid_strategy_implementations_read ON public.marketing_paid_strategy_implementations FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));

-- Budget reserved by implementations that are still in flight. A reservation is released when the
-- implementation is completed, cancelled or failed, or when its linked task is done or cancelled
-- (from then on any real spend appears in the run-rate projection, so counting it again would double-count).
CREATE FUNCTION public.paid_strategy_reserved_dkk(p_exclude uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(i.budget_reserved_dkk), 0)
  FROM public.marketing_paid_strategy_implementations i
  WHERE i.status IN ('approved','started','in_motion','needs_attention')
    AND (p_exclude IS NULL OR i.id <> p_exclude)
    AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = i.linked_task_id AND t.status::text IN ('done','cancelled'));
$$;

-- The single atomic admission point for an approved implementation. Serialises concurrent approvals
-- (advisory lock) so shared headroom can never be oversubscribed, and makes a double click a no-op.
-- Headroom is read from the run's own stored evidence, never from the caller.
CREATE FUNCTION public.approve_paid_strategy_implementation(
  p_run_id uuid, p_index smallint, p_actor uuid, p_mode text, p_budget numeric, p_inputs jsonb, p_compiled jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_latest uuid; v_row public.marketing_paid_strategy_implementations%ROWTYPE;
  v_reliable boolean; v_headroom numeric; v_reserved numeric; v_available numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('paid_strategy_budget_reservation'));
  IF p_mode NOT IN ('platform_action','implementation_task','creative_task','implementation_package') THEN
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
  -- Only a prepared, input-needing or cleanly failed implementation can be claimed. Anything else is already in flight or done.
  IF v_row.status NOT IN ('prepared','needs_input','failed') OR (v_row.status = 'failed' AND v_row.linked_task_id IS NOT NULL) THEN
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

COMMENT ON TABLE public.marketing_paid_strategy_implementations IS
  'One implementation state per Paid Strategy recommendation. Tasks, launch packages and (existing-object) platform actions only; never creates Meta campaigns.';
