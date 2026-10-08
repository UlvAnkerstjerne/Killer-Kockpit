-- Marketing Brain: Paid Strategy (MESPER) runs. File only: applying this migration is a separate release step.
--
-- Why a new table: marketing_creative_intelligence_runs is Instagram/organic-specific (NOT NULL
-- analysis window, classification_version, signals). paid_recommendations is one row per existing
-- campaign with a platform-execution lifecycle and must not be distorted. ai_usage_events is
-- content-free telemetry by design. Paid strategy output is advisory, not tied to a campaign_id,
-- and has no execution path, so it gets its own small run history.
CREATE TABLE public.marketing_paid_strategy_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  lease_expires_at timestamptz,
  window_start date NOT NULL,
  window_end date NOT NULL CHECK (window_end >= window_start),
  model text CHECK (length(model) <= 120),
  -- Provenance: our prompt/schema version, the pinned third-party skill, and a hash of its files.
  prompt_version text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 80),
  skill_ref text NOT NULL CHECK (length(skill_ref) BETWEEN 1 AND 120),
  skill_hash text NOT NULL CHECK (skill_hash ~ '^[a-f0-9]{64}$'),
  -- Exactly what was sent to the model (whitelisted aggregates, no platform IDs).
  evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 200000)),
  recommendations jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(recommendations) = 'array' AND jsonb_array_length(recommendations) <= 3 AND octet_length(recommendations::text) <= 30000),
  error text CHECK (length(error) <= 500),
  CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CHECK (status <> 'completed' OR evidence IS NOT NULL)
);
-- Atomic refresh admission across processes, with an expiring lease for interrupted runs.
CREATE UNIQUE INDEX marketing_paid_strategy_one_running_idx ON public.marketing_paid_strategy_runs ((true)) WHERE status = 'running';
CREATE INDEX marketing_paid_strategy_latest_idx ON public.marketing_paid_strategy_runs(generated_at DESC) WHERE status = 'completed';
CREATE INDEX marketing_paid_strategy_started_idx ON public.marketing_paid_strategy_runs(started_at DESC);
CREATE INDEX marketing_paid_strategy_requester_idx ON public.marketing_paid_strategy_runs(requested_by);

ALTER TABLE public.marketing_paid_strategy_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_paid_strategy_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.marketing_paid_strategy_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_paid_strategy_runs TO service_role;

-- Same read access as the rest of Marketing Brain: active SUPER_ADMIN, or workspace access + paid_manage.
-- No user-JWT writes; the server action authorizes SUPER_ADMIN before service_role is created.
CREATE POLICY marketing_paid_strategy_runs_read ON public.marketing_paid_strategy_runs FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));

COMMENT ON TABLE public.marketing_paid_strategy_runs IS
  'Advisory MESPER paid-strategy analyses (max 3 recommendations per run). Never executable; operational changes stay in paid_recommendations.';
