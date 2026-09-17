-- Personalized Weekly Impact Brief delivery ledger.
-- Generation previews do not write here; this table exists for the gated
-- automated sender so retries are safe and one user/week cannot be sent twice.

CREATE TABLE public.weekly_impact_brief_deliveries (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  week_start         date        NOT NULL,
  status             text        NOT NULL DEFAULT 'generating'
                                 CHECK (status IN ('generating', 'sent', 'failed')),
  attempt_count      integer     NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  evidence_json      jsonb,
  brief_json         jsonb,
  subject            text,
  payload_json       jsonb,
  send_started_at    timestamptz,
  resend_id          text,
  error              text,
  generation_started_at timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_impact_brief_user_week_unique UNIQUE (user_id, week_start)
);

CREATE INDEX weekly_impact_brief_status_idx
  ON public.weekly_impact_brief_deliveries (status, week_start);

CREATE INDEX weekly_impact_brief_user_idx
  ON public.weekly_impact_brief_deliveries (user_id, week_start DESC);

ALTER TABLE public.weekly_impact_brief_deliveries ENABLE ROW LEVEL SECURITY;

-- Deliberately service-role only. Preview access is mediated by a management-
-- authorised server action and automated delivery runs through CRON_SECRET.
REVOKE ALL ON TABLE public.weekly_impact_brief_deliveries FROM anon, authenticated;
GRANT ALL ON TABLE public.weekly_impact_brief_deliveries TO service_role;
