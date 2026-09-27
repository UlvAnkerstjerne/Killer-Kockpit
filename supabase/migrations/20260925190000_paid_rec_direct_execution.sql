ALTER TABLE public.paid_recommendations
  ADD COLUMN execution_plan jsonb,
  ADD COLUMN execution_plan_version text;

ALTER TABLE public.paid_recommendations DROP CONSTRAINT paid_rec_execution_status_check;
ALTER TABLE public.paid_recommendations ADD CONSTRAINT paid_rec_execution_status_check
  CHECK (execution_status IN ('pending_approval', 'executing', 'in_motion', 'completed', 'failed', 'needs_attention'));

CREATE TABLE public.paid_recommendation_execution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL REFERENCES public.paid_recommendations(id),
  actor_user_id uuid REFERENCES auth.users(id),
  phase text NOT NULL CHECK (phase IN ('claimed','prepared','mutation_requested','verified','completed','failed','needs_attention')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.paid_recommendation_execution_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_recommendation_execution_events FROM anon, authenticated;
GRANT ALL ON public.paid_recommendation_execution_events TO service_role;
CREATE INDEX paid_rec_execution_events_rec_idx ON public.paid_recommendation_execution_events(recommendation_id, created_at);

COMMENT ON COLUMN public.paid_recommendations.execution_plan IS
  'Server-compiled, allowlisted plan. Null for legacy and non-executable recommendations.';
