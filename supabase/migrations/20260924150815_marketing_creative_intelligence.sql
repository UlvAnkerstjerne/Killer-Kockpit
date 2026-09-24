-- Marketing Brain v1. File only: applying this migration is a separate release step.
-- One current fingerprint per Instagram item; source/version provenance allows regeneration.
CREATE TABLE public.marketing_content_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL DEFAULT 'instagram' CHECK (platform = 'instagram'),
  media_id text NOT NULL REFERENCES public.meta_ig_media(id) ON DELETE CASCADE,
  classification_version text NOT NULL CHECK (length(classification_version) BETWEEN 1 AND 80),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  classified_at timestamptz NOT NULL DEFAULT now(),
  ai_model text NOT NULL CHECK (length(ai_model) BETWEEN 1 AND 120),
  prompt_version text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 80),
  hook_type text NOT NULL CHECK (hook_type IN ('question','bold_claim','contrarian','comparison','curiosity','problem_solution','direct_product','story','list','social_proof','offer','no_clear_hook','unknown')),
  hook_text text CHECK (length(hook_text) BETWEEN 1 AND 240),
  hook_source text NOT NULL CHECK (hook_source IN ('caption','video_transcript','manual','unknown')),
  primary_theme text NOT NULL CHECK (primary_theme IN ('product','food_process','education_explainer','humour','behind_the_scenes','founder_personality','people_team','social_proof','community','offer_promotion','brand_story','other')),
  secondary_themes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(secondary_themes) <= 2 AND secondary_themes <@ ARRAY['product','food_process','education_explainer','humour','behind_the_scenes','founder_personality','people_team','social_proof','community','offer_promotion','brand_story','other']::text[] AND array_position(secondary_themes, NULL) IS NULL),
  product_focus text NOT NULL CHECK (product_focus IN ('kebab','falafel','chicken','fries','lemonade','beer','catering','general_brand','multiple','none','unknown')),
  creative_format text NOT NULL CHECK (creative_format IN ('reel_video','carousel','image','unknown')),
  presentation_style text NOT NULL CHECK (presentation_style IN ('food_closeup','human_to_camera','voiceover','text_led','process_footage','store_footage','mixed','unknown')),
  human_presence text NOT NULL CHECK (human_presence IN ('present','absent','unknown')),
  language text NOT NULL CHECK (language IN ('da','en','sv','mixed','other','unknown')),
  cta_type text NOT NULL CHECK (cta_type IN ('visit','order','comment','share','save','follow','link','none','unknown')),
  confidence text NOT NULL CHECK (confidence IN ('low','medium','high')),
  UNIQUE (platform, media_id),
  CHECK ((hook_type = 'unknown' AND hook_source = 'unknown' AND hook_text IS NULL)
    OR (hook_type = 'no_clear_hook' AND hook_source <> 'unknown' AND hook_text IS NULL)
    OR (hook_type NOT IN ('unknown','no_clear_hook') AND hook_source <> 'unknown' AND hook_text IS NOT NULL)),
  CHECK (NOT primary_theme = ANY(secondary_themes))
);
CREATE INDEX marketing_fingerprints_media_idx ON public.marketing_content_fingerprints(media_id);
CREATE INDEX marketing_fingerprints_version_idx ON public.marketing_content_fingerprints(classification_version, classified_at DESC);

CREATE TABLE public.marketing_creative_intelligence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  analysis_start timestamptz NOT NULL,
  analysis_end timestamptz NOT NULL CHECK (analysis_end > analysis_start),
  model text CHECK (length(model) <= 120),
  prompt_version text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 80),
  classification_version text NOT NULL CHECK (length(classification_version) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  lease_expires_at timestamptz,
  analytics jsonb CHECK (analytics IS NULL OR (jsonb_typeof(analytics) = 'object' AND octet_length(analytics::text) <= 2000000)),
  signals jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(signals) = 'array' AND jsonb_array_length(signals) <= 20 AND octet_length(signals::text) <= 200000),
  observations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(observations) = 'array' AND jsonb_array_length(observations) <= 5 AND octet_length(observations::text) <= 20000),
  classification_counts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(classification_counts) = 'object' AND octet_length(classification_counts::text) <= 2000),
  error text CHECK (length(error) <= 500),
  CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('completed','partial') OR analytics IS NOT NULL)
);
-- Atomic refresh admission across processes, with expiring leases for interrupted runs.
CREATE UNIQUE INDEX marketing_creative_one_running_idx ON public.marketing_creative_intelligence_runs ((true)) WHERE status = 'running';
CREATE INDEX marketing_creative_latest_idx ON public.marketing_creative_intelligence_runs(generated_at DESC) WHERE status IN ('completed','partial');
CREATE INDEX marketing_creative_started_idx ON public.marketing_creative_intelligence_runs(started_at DESC);
CREATE INDEX marketing_creative_requester_idx ON public.marketing_creative_intelligence_runs(requested_by);

ALTER TABLE public.marketing_content_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_creative_intelligence_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_content_fingerprints, public.marketing_creative_intelligence_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.marketing_content_fingerprints, public.marketing_creative_intelligence_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_content_fingerprints, public.marketing_creative_intelligence_runs TO service_role;

-- Same access as Organic today: active SUPER_ADMIN, or workspace access + paid_manage.
-- No user-JWT writes; the server action authorizes SUPER_ADMIN before service_role creation.
CREATE POLICY marketing_fingerprints_read ON public.marketing_content_fingerprints FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));
CREATE POLICY marketing_creative_runs_read ON public.marketing_creative_intelligence_runs FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.app_users u WHERE u.id = (SELECT public.get_my_app_user_id()) AND u.active
    AND (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM public.user_marketing_permissions p WHERE p.user_id = u.id AND p.permission = 'paid_manage'
    )))
));
