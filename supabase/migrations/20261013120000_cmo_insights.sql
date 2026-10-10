-- CMO Insights. File only: applying this migration is a separate release step.
--
-- Durable marketing insights, kept DISTINCT from signals (per-run, deterministic), recommendations (Paid Strategy) and actions
-- (Paid Strategy implementations). An insight links to those; it never copies their state.
--   marketing_insights              one row per durable insight, current wording + trend
--   marketing_insight_observations  one row per (insight, source run): how it looked in that run (history; gained/lost support)
--   marketing_insight_links         insight -> recommendation / run it was derived from or that it informed
-- Same read access as Creative Intelligence (active SUPER_ADMIN, or marketing access + paid_manage). No user-JWT writes: the
-- generators and the SUPER_ADMIN capture action write through service_role after authorizing.

CREATE TABLE public.marketing_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL CHECK (domain IN ('paid','organic','creative')),
  -- The source that created it; only that source can count it as not reproduced. meta_account_checks = the deterministic
  -- facebook-ads checklist evaluated on stored Meta data (no model involved).
  origin_kind text NOT NULL CHECK (origin_kind IN ('creative_run','paid_strategy_run','meta_account_checks')),
  kind text NOT NULL CHECK (kind IN ('finding','content_opportunity','retargeting_hypothesis')),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 120),
  stable_key text CHECK (stable_key IS NULL OR length(stable_key) BETWEEN 1 AND 600),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  evidence_text text CHECK (evidence_text IS NULL OR length(evidence_text) <= 2000),
  limitations text CHECK (limitations IS NULL OR length(limitations) <= 1500),
  suggestion text CHECK (suggestion IS NULL OR length(suggestion) <= 1500),
  strength text NOT NULL CHECK (strength IN ('strong_pattern','reasonable_inference','weak_signal','hypothesis')),
  peak_strength text NOT NULL CHECK (peak_strength IN ('strong_pattern','reasonable_inference','weak_signal','hypothesis')),
  trend text NOT NULL CHECK (trend IN ('new','strengthening','steady','weakening','unconfirmed')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale')),
  times_observed integer NOT NULL DEFAULT 1 CHECK (times_observed >= 1),
  runs_since_seen integer NOT NULL DEFAULT 0 CHECK (runs_since_seen >= 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_supported_at timestamptz NOT NULL,
  -- The latest source run that touched this row (observed or missed): makes every capture step idempotent per run.
  last_source_run_id uuid,
  refs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(refs) = 'array' AND jsonb_array_length(refs) <= 30 AND octet_length(refs::text) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (first_seen_at <= last_seen_at)
);
-- An exact identity (creative: the signal ids a conclusion rests on) can exist only once.
CREATE UNIQUE INDEX marketing_insights_stable_key_idx ON public.marketing_insights(domain, kind, stable_key) WHERE stable_key IS NOT NULL;
CREATE INDEX marketing_insights_scope_idx ON public.marketing_insights(domain, status, last_supported_at DESC);
CREATE INDEX marketing_insights_recent_idx ON public.marketing_insights(last_supported_at DESC);

CREATE TABLE public.marketing_insight_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id uuid NOT NULL REFERENCES public.marketing_insights(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('creative_run','paid_strategy_run','meta_account_checks')),
  -- Deliberately not a foreign key: the sources differ (a checklist evaluation has no run row, only a deterministic id per day).
  source_run_id uuid NOT NULL,
  source_index integer CHECK (source_index IS NULL OR source_index BETWEEN 0 AND 20),
  observed_at timestamptz NOT NULL,
  strength text NOT NULL CHECK (strength IN ('strong_pattern','reasonable_inference','weak_signal','hypothesis')),
  change text NOT NULL CHECK (change IN ('new','strengthened','reconfirmed','weakened')),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  evidence_text text CHECK (evidence_text IS NULL OR length(evidence_text) <= 2000),
  limitations text CHECK (limitations IS NULL OR length(limitations) <= 1500),
  refs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(refs) = 'array' AND jsonb_array_length(refs) <= 30 AND octet_length(refs::text) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (insight_id, source_kind, source_run_id)
);
CREATE INDEX marketing_insight_observations_run_idx ON public.marketing_insight_observations(source_kind, source_run_id);
CREATE INDEX marketing_insight_observations_history_idx ON public.marketing_insight_observations(insight_id, observed_at DESC);

CREATE TABLE public.marketing_insight_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id uuid NOT NULL REFERENCES public.marketing_insights(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('paid_strategy_recommendation','paid_strategy_run','creative_run')),
  target_run_id uuid NOT NULL,
  target_index integer CHECK (target_index IS NULL OR target_index BETWEEN 0 AND 20),
  -- derived_from: the insight was extracted from that recommendation. informed: the insight was in front of that later run.
  relation text NOT NULL CHECK (relation IN ('derived_from','informed')),
  -- A plain column the unique constraint can use (NULL index counts as one slot), so upserts stay idempotent.
  target_slot integer GENERATED ALWAYS AS (COALESCE(target_index, -1)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_type = 'paid_strategy_recommendation') = (target_index IS NOT NULL)),
  UNIQUE (insight_id, target_type, target_run_id, target_slot, relation)
);
CREATE INDEX marketing_insight_links_target_idx ON public.marketing_insight_links(target_type, target_run_id);

-- "Do something about it": the options drafted for an insight and the one a person chose. One row per option. An action points at
-- the task or the Paid Strategy recommendation that carries out the work and never copies their state; its outcome records how it
-- ended and what the insight looked like then, so later analyses can learn from what people did. Nothing is executed from here.
CREATE TABLE public.marketing_insight_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id uuid NOT NULL REFERENCES public.marketing_insights(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('implement_recommendation','manual_task','content_brief')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','superseded','not_chosen','chosen','completed','abandoned')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  why text NOT NULL CHECK (length(why) BETWEEN 1 AND 1200),
  steps jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 8 AND octet_length(steps::text) <= 6000),
  success_signal text CHECK (success_signal IS NULL OR length(success_signal) <= 800),
  brief jsonb CHECK (brief IS NULL OR (jsonb_typeof(brief) = 'object' AND octet_length(brief::text) <= 6000)),
  -- Only implement_recommendation points at a Paid Strategy recommendation (run + index 0-2); the existing flow does the work.
  target_run_id uuid,
  target_index integer CHECK (target_index IS NULL OR target_index BETWEEN 0 AND 20),
  linked_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  owner_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  due_on date,
  model text CHECK (model IS NULL OR length(model) <= 120),
  prompt_version text CHECK (prompt_version IS NULL OR length(prompt_version) <= 80),
  proposed_by_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  chosen_by_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  chosen_at timestamptz,
  completed_at timestamptz,
  outcome jsonb CHECK (outcome IS NULL OR (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 4000)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'implement_recommendation') = (target_run_id IS NOT NULL AND target_index IS NOT NULL)),
  CHECK ((kind = 'content_brief') = (brief IS NOT NULL)),
  CHECK (status IN ('proposed','superseded','not_chosen') OR chosen_at IS NOT NULL),
  CHECK (status NOT IN ('completed','abandoned') OR outcome IS NOT NULL),
  CHECK (linked_task_id IS NULL OR kind <> 'implement_recommendation')
);
-- A task carries out at most one action.
CREATE UNIQUE INDEX marketing_insight_actions_task_idx ON public.marketing_insight_actions(linked_task_id) WHERE linked_task_id IS NOT NULL;
-- ONE choice per draft, enforced by the database: two people (or two tabs) choosing different options at the same moment cannot both win.
CREATE UNIQUE INDEX marketing_insight_actions_one_choice_idx ON public.marketing_insight_actions(batch_id) WHERE status IN ('chosen','completed','abandoned');
CREATE INDEX marketing_insight_actions_insight_idx ON public.marketing_insight_actions(insight_id, proposed_at DESC);
CREATE INDEX marketing_insight_actions_open_idx ON public.marketing_insight_actions(status) WHERE status = 'chosen';

ALTER TABLE public.marketing_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_insight_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_insight_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_insight_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_insights, public.marketing_insight_observations, public.marketing_insight_links, public.marketing_insight_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.marketing_insights, public.marketing_insight_observations, public.marketing_insight_links, public.marketing_insight_actions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_insights, public.marketing_insight_observations, public.marketing_insight_links, public.marketing_insight_actions TO service_role;

-- Same access as Creative Intelligence: active SUPER_ADMIN, or workspace access + paid_manage.
CREATE POLICY marketing_insights_read ON public.marketing_insights FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));
CREATE POLICY marketing_insight_observations_read ON public.marketing_insight_observations FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));
CREATE POLICY marketing_insight_links_read ON public.marketing_insight_links FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));
CREATE POLICY marketing_insight_actions_read ON public.marketing_insight_actions FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));
