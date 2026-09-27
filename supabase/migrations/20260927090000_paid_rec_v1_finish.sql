-- Fix execution events actor_user_id FK: was auth.users, should be app_users
ALTER TABLE public.paid_recommendation_execution_events
  DROP CONSTRAINT IF EXISTS paid_recommendation_execution_events_actor_user_id_fkey;
ALTER TABLE public.paid_recommendation_execution_events
  ADD CONSTRAINT paid_recommendation_execution_events_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES public.app_users(id);

-- Add Google Ads budget metadata to campaigns table
ALTER TABLE public.google_ads_campaigns
  ADD COLUMN IF NOT EXISTS budget_resource_name text,
  ADD COLUMN IF NOT EXISTS daily_budget_micros bigint,
  ADD COLUMN IF NOT EXISTS budget_explicitly_shared boolean;

COMMENT ON COLUMN public.google_ads_campaigns.budget_resource_name IS
  'Campaign budget resource name, e.g. customers/8582465933/campaignBudgets/123. Synced from campaign.campaign_budget.';
COMMENT ON COLUMN public.google_ads_campaigns.daily_budget_micros IS
  'Campaign daily budget in micros (1 DKK = 1000000 micros). From campaign_budget.amount_micros.';
COMMENT ON COLUMN public.google_ads_campaigns.budget_explicitly_shared IS
  'True if the budget is shared across multiple campaigns. Shared budgets are rejected for automation.';
