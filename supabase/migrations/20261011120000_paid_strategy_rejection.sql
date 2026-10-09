-- Paid Strategy: human rejection. File only: applying this migration is a separate, explicitly approved step.
--
-- A person can decide "No, we do not want this strategy". That is a strategic decision about the idea, recorded on the
-- same (strategy_run_id, recommendation_index) row as everything else, so the unique relationship stays authoritative.
-- It is NOT a cancel: cancel stops an implementation, reject says the recommendation should not be pursued, and the
-- decision informs later Paid Strategy analyses (see human_strategy_decisions in the evidence).
--
-- Rejecting never touches Meta. Paused objects that were already created stay paused and cannot spend.

-- 'rejected' is a new terminal status. A rejection can exist without an approval (rejected straight from the card).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.marketing_paid_strategy_implementations'::regclass AND contype = 'c'
             AND conname IN ('paid_strategy_implementation_status_check', 'paid_strategy_implementation_approved_check')
  LOOP EXECUTE format('ALTER TABLE public.marketing_paid_strategy_implementations DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;

ALTER TABLE public.marketing_paid_strategy_implementations
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN rejected_by_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  ADD COLUMN rejection_reason text CHECK (length(rejection_reason) <= 500),
  ADD CONSTRAINT paid_strategy_implementation_status_check CHECK (status IN (
    'prepared','needs_input','approved','planning','executing','verifying','waiting_for_input','waiting_for_access',
    'ready_to_activate','started','in_motion','completed','cancelled','needs_attention','failed','rejected')),
  ADD CONSTRAINT paid_strategy_implementation_approved_check CHECK (
    status IN ('prepared','needs_input','cancelled','failed','rejected') OR approved_at IS NOT NULL),
  ADD CONSTRAINT paid_strategy_implementation_rejected_check CHECK (
    (status = 'rejected') = (rejected_at IS NOT NULL) AND (status = 'rejected' OR (rejected_by_user_id IS NULL AND rejection_reason IS NULL))),
  -- A rejection reserves nothing.
  ADD CONSTRAINT paid_strategy_implementation_rejected_budget_check CHECK (status <> 'rejected' OR budget_reserved_dkk = 0);

CREATE INDEX paid_strategy_implementations_rejected_by_idx ON public.marketing_paid_strategy_implementations(rejected_by_user_id);
CREATE INDEX paid_strategy_implementations_rejected_at_idx ON public.marketing_paid_strategy_implementations(rejected_at) WHERE status = 'rejected';

-- 'rejected' is intentionally absent: a rejected implementation no longer counts toward the shared headroom.
-- (Unchanged from the autonomous-execution migration; restated so the rule is visible next to the new status.)
CREATE OR REPLACE FUNCTION public.paid_strategy_reserved_dkk(p_exclude uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(i.budget_reserved_dkk), 0)
  FROM public.marketing_paid_strategy_implementations i
  WHERE i.status IN ('approved','planning','executing','verifying','waiting_for_input','waiting_for_access','ready_to_activate','started','in_motion','needs_attention')
    AND (p_exclude IS NULL OR i.id <> p_exclude)
    AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = i.linked_task_id AND t.status::text IN ('done','cancelled'));
$$;

-- One atomic decision. Same serialisation as approval (advisory lock), so a reject, an approve and a double click
-- can never interleave: whichever takes the row first wins, and the other sees the settled status.
CREATE OR REPLACE FUNCTION public.reject_paid_strategy_implementation(p_run_id uuid, p_index smallint, p_actor uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_latest uuid; v_recs jsonb; v_rec jsonb; v_row public.marketing_paid_strategy_implementations%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_released numeric; v_meta_objects boolean; v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('paid_strategy_budget_reservation'));
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN RETURN jsonb_build_object('result','reason_too_long'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users u WHERE u.id = p_actor AND u.active) THEN RETURN jsonb_build_object('result','actor_inactive'); END IF;

  SELECT id INTO v_latest FROM public.marketing_paid_strategy_runs WHERE status = 'completed' ORDER BY generated_at DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_run_id THEN RETURN jsonb_build_object('result','superseded'); END IF;
  SELECT recommendations INTO v_recs FROM public.marketing_paid_strategy_runs WHERE id = p_run_id;
  v_rec := v_recs -> p_index::int;
  IF v_rec IS NULL OR jsonb_typeof(v_rec) <> 'object' THEN RETURN jsonb_build_object('result','not_found'); END IF;

  SELECT * INTO v_row FROM public.marketing_paid_strategy_implementations WHERE strategy_run_id = p_run_id AND recommendation_index = p_index FOR UPDATE;
  IF NOT FOUND THEN
    -- Nothing was ever prepared: persist the decision on the minimal row the unique key allows.
    INSERT INTO public.marketing_paid_strategy_implementations
      (strategy_run_id, recommendation_index, recommendation_snapshot, implementation_mode, status, budget_reserved_dkk, rejected_at, rejected_by_user_id, rejection_reason, updated_at)
    VALUES (p_run_id, p_index, v_rec, 'needs_input', 'rejected', 0, now(), p_actor, v_reason, now())
    ON CONFLICT (strategy_run_id, recommendation_index) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN jsonb_build_object('result','conflict'); END IF;
    INSERT INTO public.audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (p_actor, 'human', 'marketing.paid_strategy_implementation.rejected', 'paid_strategy_implementation', v_id,
      jsonb_build_object('status', NULL),
      jsonb_build_object('strategy_run_id', p_run_id, 'recommendation_index', p_index, 'previous_status', NULL, 'reason', v_reason, 'budget_released_dkk', 0, 'meta_objects_existed', false));
    RETURN jsonb_build_object('result','rejected','id',v_id,'previous_status',NULL,'released',0,'meta_objects_existed',false);
  END IF;

  IF v_row.status = 'rejected' THEN RETURN jsonb_build_object('result','already_rejected','id',v_row.id); END IF;
  IF v_row.status IN ('approved','planning','executing','verifying') THEN RETURN jsonb_build_object('result','in_flight','status',v_row.status,'id',v_row.id); END IF;
  IF v_row.status IN ('in_motion','completed','started') THEN RETURN jsonb_build_object('result','live','status',v_row.status,'id',v_row.id); END IF;

  v_released := v_row.budget_reserved_dkk;
  v_meta_objects := (v_row.execution -> 'evidence' -> 'created') IS NOT NULL;
  UPDATE public.marketing_paid_strategy_implementations SET
    status = 'rejected', budget_reserved_dkk = 0, rejected_at = now(), rejected_by_user_id = p_actor, rejection_reason = v_reason, error = NULL, updated_at = now()
   WHERE id = v_row.id;
  INSERT INTO public.audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (p_actor, 'human', 'marketing.paid_strategy_implementation.rejected', 'paid_strategy_implementation', v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('strategy_run_id', p_run_id, 'recommendation_index', p_index, 'previous_status', v_row.status, 'reason', v_reason, 'budget_released_dkk', v_released, 'meta_objects_existed', v_meta_objects));
  RETURN jsonb_build_object('result','rejected','id',v_row.id,'previous_status',v_row.status,'released',v_released,'meta_objects_existed',v_meta_objects);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reject_paid_strategy_implementation(uuid, smallint, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_paid_strategy_implementation(uuid, smallint, uuid, text) TO service_role;

COMMENT ON COLUMN public.marketing_paid_strategy_implementations.rejection_reason IS
  'Why a person rejected this recommendation. Free text, optional, shown on the card and given to later Paid Strategy analyses as a human business decision (never as performance evidence).';
