-- M2: Paid Recommendations
-- AI-generated campaign recommendations awaiting human review.
--
-- Lifecycle: needs_review → approved | dismissed
-- All mutations are performed server-side via service_role; RLS is enabled for
-- defence-in-depth but the app does not rely on JWT-level access to this table.
--
-- signal_context columns capture the data snapshot used at generation time so
-- the recommendation card can display evidence without a second query.

CREATE TABLE public.paid_recommendations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              text        NOT NULL CHECK (platform IN ('meta', 'google')),
  campaign_id           text        NOT NULL,
  campaign_name         text        NOT NULL,
  signal_type           text        NOT NULL CHECK (signal_type IN (
                          'spend_no_results', 'cpr_worsening', 'cpr_improving', 'strong_performance'
                        )),

  -- Signal context snapshot captured at generation time.
  spend_7d              numeric,
  currency              text,
  result_label          text,
  result_count_7d       numeric,
  cpr_7d                numeric,
  spend_prior_7d        numeric,
  result_count_prior_7d numeric,
  cpr_prior_7d          numeric,
  change_pct            numeric,    -- fractional: 0.25 = +25%

  -- AI-generated wording. Immutable after insert.
  what_changed          text        NOT NULL,
  evidence              text        NOT NULL,
  interpretation        text        NOT NULL,
  recommended_action    text        NOT NULL,
  urgency               text        NOT NULL CHECK (urgency IN ('high', 'medium', 'low')),

  -- Review lifecycle.
  status                text        NOT NULL DEFAULT 'needs_review'
                          CHECK (status IN ('needs_review', 'approved', 'dismissed')),
  reviewed_at           timestamptz,
  reviewed_by_user_id   uuid        REFERENCES public.app_users(id) ON DELETE SET NULL,

  -- AI metadata.
  ai_model              text,
  prompt_version        text,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.paid_recommendations ENABLE ROW LEVEL SECURITY;

-- Users with marketing_access can read via JWT.
-- All app writes use service_role and bypass RLS.
CREATE POLICY "paid_recommendations_read" ON public.paid_recommendations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.app_users
      WHERE id = auth.uid()
        AND (role = 'SUPER_ADMIN' OR marketing_access = true)
    )
  );

COMMENT ON TABLE public.paid_recommendations IS
  'AI-generated paid campaign recommendations. Reviewed and approved/dismissed by authorised marketing users.';
