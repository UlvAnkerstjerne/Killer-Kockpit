-- Institutional Google Ads v25 reporting. No user IDs or credentials in metrics.
CREATE TABLE public.google_ads_accounts (
  customer_id text PRIMARY KEY,
  name text,
  currency_code text NOT NULL,
  time_zone text NOT NULL,
  conversion_customer_id text,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.google_ads_campaigns (
  customer_id text NOT NULL REFERENCES public.google_ads_accounts(customer_id),
  campaign_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  channel_type text NOT NULL,
  channel_sub_type text,
  bidding_strategy_type text,
  goal_config_level text,
  conversion_goals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conversion_goals) = 'array'),
  custom_conversion_goal jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, campaign_id)
);

CREATE TABLE public.google_ads_conversion_actions (
  customer_id text NOT NULL REFERENCES public.google_ads_accounts(customer_id),
  resource_name text NOT NULL,
  action_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  type text NOT NULL,
  category text NOT NULL,
  origin text,
  primary_for_goal boolean NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, resource_name)
);

CREATE TABLE public.google_ads_campaign_daily (
  customer_id text NOT NULL,
  campaign_id text NOT NULL,
  date date NOT NULL,
  impressions bigint NOT NULL,
  clicks bigint NOT NULL,
  cost_micros bigint NOT NULL,
  cost numeric(20,6) GENERATED ALWAYS AS (cost_micros::numeric / 1000000) STORED,
  conversions numeric NOT NULL,
  conversion_value numeric NOT NULL,
  all_conversions numeric NOT NULL,
  all_conversion_value numeric NOT NULL,
  conversion_results jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conversion_results) = 'array'),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, campaign_id, date),
  FOREIGN KEY (customer_id, campaign_id) REFERENCES public.google_ads_campaigns(customer_id, campaign_id)
);
CREATE INDEX google_ads_campaign_daily_customer_date_idx ON public.google_ads_campaign_daily(customer_id, date);

COMMENT ON COLUMN public.google_ads_campaign_daily.conversion_results IS
  'Campaign/day conversion-action counts and values, including source action name/category. Spend exists only in the parent daily row; never sum duplicated spend across result types.';
COMMENT ON COLUMN public.google_ads_campaigns.conversion_goals IS
  'Current Google category/origin/biddable settings, not an inferred campaign objective or historical goal snapshot.';

ALTER TABLE public.google_ads_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_ads_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_ads_conversion_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_ads_campaign_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_ads_accounts, public.google_ads_campaigns, public.google_ads_conversion_actions, public.google_ads_campaign_daily FROM anon, authenticated;
GRANT ALL ON public.google_ads_accounts, public.google_ads_campaigns, public.google_ads_conversion_actions, public.google_ads_campaign_daily TO service_role;
