/**
 * lib/marketing/brief/types.ts
 *
 * TypeScript types and Zod runtime schemas for the Marketing Morning Brief.
 *
 * Two layers:
 *   BriefInputData — compact computed data assembled by collect-data.ts before the AI call
 *   MorningBriefRow — DB row shape read at page render time
 *   MorningBriefSections — structured JSONB stored in sections_json
 *   MorningBriefAIOutputSchema — Zod schema for runtime-validating the Claude response
 *
 * Zod is used for AI output validation only — TypeScript types are used everywhere else.
 * AI output validation is the sole place where runtime schema checking is required because
 * the response comes from an external AI model and can deviate from the expected shape.
 */

import { z } from 'zod'

// ─── Core brief lifecycle ──────────────────────────────────────────────────────

export type BriefStatus = 'pending' | 'generating' | 'ready' | 'failed'
export type OverallStatus = 'green' | 'amber' | 'red'

// ─── Source freshness ─────────────────────────────────────────────────────────
//
// Persisted at generation time so the rendered brief accurately describes
// how current its data is — without making any live integration calls at render.
//
// Different integrations have different expected freshness:
//   meta_ads_daily / meta_ig_account_daily / meta_fb_page_daily:
//     Expected: < 24h. Critical: failure or > 36h means data is stale.
//   meta_ig_organic_deep / meta_fb_organic_deep:
//     Expected: < 7 days (runs weekly). age_hours > 168 is stale.
//   meta_ads_backfill:
//     Status 'syncing' is NORMAL and must not contribute to unhealthy status.
//   gbp:
//     status = 'pending_approval' is expected until Google approves API access.

export interface IntegrationFreshness {
  last_success_at: string | null    // ISO timestamp or null
  status: string                    // sync status from integration_sync_state
  age_hours: number | null          // hours since last success, or null if never
  healthy: boolean                  // whether this source is within expected freshness
}

export interface SourceFreshnessSummary {
  meta_ads_daily:        IntegrationFreshness
  meta_ig_account_daily: IntegrationFreshness
  meta_ig_organic_deep:  IntegrationFreshness
  meta_fb_page_daily:    IntegrationFreshness
  meta_fb_organic_deep:  IntegrationFreshness
  gbp:                   GbpIntegrationStatus
}

export type GbpIntegrationStatusKind =
  | 'pending_approval'   // no GBP-scoped OAuth token exists
  | 'connected'          // OAuth token with GBP scope exists AND sync has succeeded
  | 'connected_no_sync'  // OAuth token exists but sync never succeeded

export interface GbpIntegrationStatus {
  kind: GbpIntegrationStatusKind
  last_sync_at: string | null
  healthy: boolean                  // true for pending_approval (expected); false for connected_no_sync > threshold
}

// ─── Deterministic severity signals ───────────────────────────────────────────
//
// Computed before the AI call. Drive the overall_status.
// Claude explains the status; it does not decide it.
// Stored in deterministic_signals_json for admin debugging.

export interface PaidAnomalySignal {
  campaign_name: string   // UNTRUSTED — truncated Meta text, never used as instructions
  metric_label: string    // e.g. 'spend', 'cpc', 'cpm'
  change_pct: number      // positive = increase, negative = decrease
  direction: 'increase' | 'decrease'
  yesterday_value: number
  baseline_value: number  // 6-day average (excluding yesterday)
}

export interface DeterministicSignals {
  has_stale_critical_source: boolean
  stale_sources: string[]            // integration keys that are stale/failed
  paid_anomaly_count: number
  paid_anomalies: PaidAnomalySignal[]
  organic_ig_drop_detected: boolean
  organic_ig_reach_7d_vs_prior_7d_pct: number | null
  pending_review_count: number
  gbp_kind: GbpIntegrationStatusKind
  computed_status: OverallStatus
  status_reasons: string[]           // e.g. ['stale_source:meta_ads_daily', 'paid_anomaly']
}

// ─── Brief input data (pre-AI, deterministic) ─────────────────────────────────

export interface CampaignMetrics {
  id: string
  name: string                       // UNTRUSTED — truncated
  status: string
  objective: string | null
  // Universal metrics — always available where synced
  spend_7d: number | null            // DKK (or account currency)
  spend_yesterday: number | null
  impressions_7d: number | null
  reach_7d: number | null
  clicks_7d: number | null
  ctr_7d: number | null              // percentage
  cpm_7d: number | null
  cpc_7d: number | null
  frequency_7d: number | null
  // Action-specific metrics — preserve actual action types from Meta
  // Keyed by action type string (e.g. 'link_click', 'post_engagement', 'purchase')
  // Never manufacture a single generic CPA across incompatible objectives
  primary_actions: Array<{ type: string; value_7d: number | null; cost_7d: number | null }>
  // Anomaly flag (set deterministically with volume guard)
  anomaly: PaidAnomalySignal | null
}

export interface IgAccountMetrics {
  reach_7d: number | null
  reach_prior_7d: number | null
  accounts_engaged_7d: number | null
  profile_views_7d: number | null
  followers_current: number | null
  followers_7d_delta: number | null
}

export interface IgPostSummary {
  caption_truncated: string | null    // max 80 chars, UNTRUSTED
  published_at: string
  media_type: string
  reach: number | null
  plays: number | null
  likes: number | null
  comments_count: number | null
  shares: number | null
  total_interactions: number | null
  performance_vs_avg_pct: number | null  // null if avg unavailable
}

// Facebook page-level: only metrics that v26 actually provides
export interface FbPageMetrics {
  views_7d: number | null            // page_views_total (v26)
  engaged_users_7d: number | null    // page_post_engagements (v26)
  fan_count_current: number | null
  fan_count_7d_delta: number | null
}

// Facebook post: only reactions_total and clicks — reach/views/engaged_users deprecated in v26
export interface FbPostSummary {
  message_truncated: string | null   // max 80 chars, UNTRUSTED
  published_at: string
  post_type: string
  reactions_total: number | null
  clicks: number | null
  comments: number | null
  shares: number | null
}

export interface GbpBriefData {
  integration_status: GbpIntegrationStatus
  pending_reply_count: number        // awaiting_review status
  new_reviews_yesterday: number | null  // null when not connected
  avg_star_rating_7d: number | null
}

export interface NeedsReviewCount {
  total: number
  review_reply: number
  paid_recommendation: number
  content_approval: number
}

export interface BriefInputData {
  briefDate: string               // YYYY-MM-DD in Europe/Copenhagen
  dataWindowStart: string         // YYYY-MM-DD
  dataWindowEnd: string           // YYYY-MM-DD (yesterday in Copenhagen)
  currency: string                // ISO 4217 from meta_ad_accounts, or 'DKK' fallback

  sourceFreshness: SourceFreshnessSummary
  signals: DeterministicSignals

  // null when Meta credentials not configured or sync never ran
  paid: {
    active_campaigns: CampaignMetrics[]
    paused_campaigns: CampaignMetrics[]
    total_active_spend_7d: number | null
    total_active_impressions_7d: number | null
    daily_spend_series: TrendPoint[]        // summed across active campaigns, one point per day
    daily_impressions_series: TrendPoint[]  // summed across active campaigns, one point per day
  } | null

  organic: {
    ig: IgAccountMetrics
    ig_top_posts: IgPostSummary[]    // up to 5, ranked by reach or total_interactions
    ig_avg_reach_7d: number | null   // average across posts in window (for anomaly context)
    ig_daily_reach_series: TrendPoint[]  // daily IG account reach, one point per day
    fb: FbPageMetrics
    fb_recent_posts: FbPostSummary[] // up to 5 most recent
    fb_available: boolean            // false if no FB page ID configured
    fb_daily_views_series: TrendPoint[]  // daily FB page views; empty when !fb_available
  }

  gbp: GbpBriefData
  needsReview: NeedsReviewCount
}

// ─── AI output schema (runtime-validated) ─────────────────────────────────────
//
// Claude receives the pre-determined overall_status and writes explanatory text.
// Claude does NOT decide the status — it explains it.
//
// Lengths are capped to prevent runaway responses.
// All string fields are trimmed after parsing.

export const MorningBriefAIOutputSchema = z.object({
  // 2–4 sentence executive summary; decision-oriented, not a data recap
  ai_summary: z.string().min(20).max(800),

  // Per-section assessments — short, direct
  paid_assessment: z.string().min(10).max(800),
  organic_assessment: z.string().min(10).max(800),

  // null when GBP is pending_approval or no data
  gbp_assessment: z.string().max(300).nullable(),

  // Single sentence explaining the overall status (green/amber/red)
  overall_reason: z.string().min(5).max(200),
})

export type MorningBriefAIOutput = z.infer<typeof MorningBriefAIOutputSchema>

// ─── Trend point ──────────────────────────────────────────────────────────────
//
// One data point in a sparkline series.
// Every point is a real measured value — not interpolated or fabricated.
// Zero is a valid value (zero spend, zero reach, etc.).

export interface TrendPoint {
  date: string    // YYYY-MM-DD, chronological
  value: number   // real measured value; zero is valid and distinct from missing
}

// ─── Stored section shapes (sections_json) ────────────────────────────────────
//
// These are what get persisted after combining BriefInputData with AI output.
// Read at page render time — no computation on read, only display.

export interface BriefMetricRow {
  label: string
  value: string               // pre-formatted: "DKK 4,320" / "12.4k" / "+18%"
  change?: string             // optional delta vs prior period
  highlight?: boolean         // true = display with visual emphasis (anomaly)
  trend?: TrendPoint[]        // optional sparkline series; omitted when < 2 real points exist
}

export interface StoredPaidSection {
  assessment: string          // AI-written
  anomalies: string[]         // human-readable anomaly descriptions (deterministic text)
  metrics: BriefMetricRow[]
  active_campaign_summaries: Array<{
    name: string              // UNTRUSTED — truncated campaign name
    status: string
    spend_7d_formatted: string | null
    anomaly_flag: boolean
  }>
  pending_review_count: number
}

export interface StoredOrganicSection {
  assessment: string          // AI-written
  ig: {
    metrics: BriefMetricRow[]
    notable_posts: Array<{
      caption_truncated: string | null
      media_type: string
      published_at: string
      reach: number | null
      performance_label: string | null  // e.g. "+77% vs 7d avg"
    }>
    avg_reach_7d: number | null
  }
  fb: {
    available: boolean
    metrics: BriefMetricRow[]
    recent_posts: Array<{
      message_truncated: string | null
      post_type: string
      published_at: string
      reactions_total: number | null
      clicks: number | null
    }>
  }
}

export interface StoredGbpSection {
  integration_kind: GbpIntegrationStatusKind
  assessment: string | null   // AI-written; null when pending_approval
  new_reviews_yesterday: number | null
  pending_reply_count: number
  avg_star_rating_7d: number | null
}

export interface StoredContentSection {
  status: 'placeholder'
}

export interface StoredNeedsReviewSection {
  total: number
  items: Array<{
    kind: string
    count: number
    label: string
  }>
}

export interface MorningBriefSections {
  paid:         StoredPaidSection
  organic:      StoredOrganicSection
  gbp:          StoredGbpSection
  content:      StoredContentSection
  needs_review: StoredNeedsReviewSection
}

// ─── DB row type ───────────────────────────────────────────────────────────────

export interface MorningBriefRow {
  id:                         string
  brief_date:                 string          // 'YYYY-MM-DD'
  status:                     BriefStatus
  generation_started_at:      string | null
  overall_status:             OverallStatus | null
  overall_reason:             string | null
  ai_summary:                 string | null
  sections_json:              MorningBriefSections | null
  data_window_start:          string | null
  data_window_end:            string | null
  source_freshness_json:      SourceFreshnessSummary | null
  deterministic_signals_json: DeterministicSignals | null  // SUPER_ADMIN only
  generated_at:               string | null
  generation_duration_ms:     number | null
  ai_model:                   string | null
  ai_prompt_version:          string | null
  error_message:              string | null
  // error_detail: intentionally omitted from this public row type — service_role only
  created_at:                 string
  updated_at:                 string
}
