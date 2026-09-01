/**
 * lib/marketing/types/meta.ts
 *
 * TypeScript types for Meta M3 data structures.
 * Isolated from lib/types.ts so Management routes never import Marketing types.
 */

// ── Ad account ─────────────────────────────────────────────────────────────────

export interface MetaAdAccountRow {
  id:             string
  name:           string
  currency:       string      // ISO 4217; denominator for all monetary insight values
  account_status: number | null
  synced_at:      string
}

// ── Campaign structure ─────────────────────────────────────────────────────────

export interface MetaCampaignRow {
  id:              string
  ad_account_id:   string
  name:            string
  status:          string
  objective:       string | null
  daily_budget:    string | null   // decimal string in account currency
  lifetime_budget: string | null
  created_at_meta: string | null
  synced_at:       string
}

export interface MetaAdSetRow {
  id:           string
  campaign_id:  string
  name:         string
  status:       string
  daily_budget: string | null
  synced_at:    string
}

export interface MetaAdRow {
  id:        string
  ad_set_id: string
  name:      string
  status:    string
  synced_at: string
}

// ── Insights ───────────────────────────────────────────────────────────────────
//
// spend/cpm/cpc stored as numeric(19,6) in DB — represented as string here
// to avoid float imprecision in serialisation. Currency from MetaAdAccountRow.

export interface MetaInsightActionItem {
  action_type: string
  value:       string
}

export interface MetaCampaignInsightRow {
  campaign_id:         string
  date_start:          string
  impressions:         number | null
  reach:               number | null   // campaign-level: correct, not summed from ads
  clicks:              number | null
  inline_link_clicks:  number | null
  spend:               string | null   // exact decimal string
  cpm:                 string | null
  cpc:                 string | null
  ctr:                 string | null
  frequency:           string | null
  actions_json:        MetaInsightActionItem[] | null
  cost_per_action_json: MetaInsightActionItem[] | null
  action_values_json:  MetaInsightActionItem[] | null
}

// ── Instagram ──────────────────────────────────────────────────────────────────

export interface MetaIgMediaRow {
  id:                  string
  ig_account_id:       string
  media_type:          string
  caption:             string | null
  permalink:           string | null
  published_at:        string | null
  reach:               number | null
  plays:               number | null
  saved:               number | null
  likes:               number | null
  comments_count:      number | null
  shares:              number | null
  total_interactions:  number | null
  other_metrics_json:  Record<string, number> | null
  synced_at:           string
}

export interface MetaIgAccountDailyRow {
  ig_account_id:     string
  date:              string
  reach:             number | null
  accounts_engaged:  number | null
  profile_views:     number | null
  followers_count:   number | null
  other_metrics_json: Record<string, number> | null
  synced_at:         string
}

// ── Facebook Page ──────────────────────────────────────────────────────────────

export interface MetaFbPageInsightRow {
  page_id:           string
  date:              string
  views:             number | null   // v26: replaces deprecated page_impressions
  reach:             number | null
  engaged_users:     number | null
  fan_count:         number | null
  other_metrics_json: Record<string, number> | null
}

export interface MetaFbPostRow {
  id:           string
  page_id:      string
  post_type:    string
  message:      string | null
  permalink:    string | null
  published_at: string
  synced_at:    string
}

export interface MetaFbPostInsightRow {
  post_id:           string
  views:             number | null
  reach:             number | null
  engaged_users:     number | null
  reactions_total:   number | null
  comments:          number | null
  shares:            number | null
  clicks:            number | null
  other_metrics_json: Record<string, number> | null
  synced_at:         string
}

// ── Sync status ────────────────────────────────────────────────────────────────

export interface MetaSyncStatusRow {
  integration:     string
  status:          string
  cursor:          string | null
  last_success_at: string | null
  last_attempt_at: string | null
  last_error:      string | null
}

// ── Asset discovery ────────────────────────────────────────────────────────────

export interface MetaDiscoveredAssets {
  adAccounts: Array<{ id: string; name: string; currency: string; account_status: number }>
  linkedIgAccountId: string | null   // discovered from the FB Page if PAGE_ID is set
}
