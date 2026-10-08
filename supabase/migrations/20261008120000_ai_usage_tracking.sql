-- AI Usage & Cost Tracking v1 (observability only).
--
-- ai_usage_events : one row per ACTUAL provider request (retries are separate rows).
--                   Token counts and cost only — NEVER prompts, responses or any content.
-- ai_credit_events: manually recorded API credit top-ups (SUPER_ADMIN only).
--
-- Access model
--   * Telemetry INSERT: server-side only, via service_role (feature code uses createServiceClient()).
--   * SELECT on both tables: SUPER_ADMIN only (RLS), so cost/billing data is never readable by
--     UM, Marketing read-only, Store Managers, MEMBER or anon.
--   * ai_credit_events INSERT: SUPER_ADMIN only (RLS), attributed to the signed-in user.

CREATE TABLE public.ai_usage_events (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                   timestamptz NOT NULL DEFAULT now(),

  provider                     text    NOT NULL,
  feature                      text    NOT NULL,
  model                        text,

  status                       text    NOT NULL CHECK (status IN ('success', 'error')),
  attempt                      integer NOT NULL DEFAULT 1,

  input_tokens                 bigint  NOT NULL DEFAULT 0,
  output_tokens                bigint  NOT NULL DEFAULT 0,
  cache_creation_input_tokens  bigint  NOT NULL DEFAULT 0,
  cache_read_input_tokens      bigint  NOT NULL DEFAULT 0,
  cache_creation_5m_tokens     bigint  NOT NULL DEFAULT 0,
  cache_creation_1h_tokens     bigint  NOT NULL DEFAULT 0,
  thinking_tokens              bigint,

  estimated_cost_usd           numeric(12,8),
  pricing_version              text,

  duration_ms                  integer,

  error_category               text,
  http_status                  integer,
  request_id                   text,

  -- Whitelisted, non-content flags only (cost_partial, inference_geo, operation, ...).
  metadata                     jsonb
);

CREATE INDEX ai_usage_events_created_at_idx ON public.ai_usage_events (created_at DESC);
CREATE INDEX ai_usage_events_feature_created_idx ON public.ai_usage_events (feature, created_at DESC);
CREATE INDEX ai_usage_events_errors_idx ON public.ai_usage_events (created_at DESC) WHERE status = 'error';

CREATE TABLE public.ai_credit_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text        NOT NULL,
  amount_usd          numeric     NOT NULL,
  occurred_at         timestamptz NOT NULL,
  note                text,
  created_by_user_id  uuid REFERENCES public.app_users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_credit_events_occurred_idx ON public.ai_credit_events (provider, occurred_at);

ALTER TABLE public.ai_usage_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_usage_events  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ai_credit_events FROM PUBLIC, anon, authenticated;

-- Telemetry writes: service_role only.
GRANT SELECT, INSERT ON public.ai_usage_events  TO service_role;
GRANT SELECT, INSERT ON public.ai_credit_events TO service_role;

-- SUPER_ADMIN reads through the normal user session.
GRANT SELECT ON public.ai_usage_events  TO authenticated;
GRANT SELECT, INSERT ON public.ai_credit_events TO authenticated;

CREATE POLICY "ai_usage_events: SUPER_ADMIN can read"
  ON public.ai_usage_events FOR SELECT TO authenticated
  USING (get_my_role() = 'SUPER_ADMIN');

CREATE POLICY "ai_credit_events: SUPER_ADMIN can read"
  ON public.ai_credit_events FOR SELECT TO authenticated
  USING (get_my_role() = 'SUPER_ADMIN');

CREATE POLICY "ai_credit_events: SUPER_ADMIN can insert"
  ON public.ai_credit_events FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'SUPER_ADMIN' AND created_by_user_id = get_my_app_user_id());
