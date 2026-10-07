/**
 * lib/marketing/paid-recs/types.ts
 *
 * Shared types for the Paid Recommendations module (M2).
 *
 * Three layers:
 *   PaidRecSignal   — deterministic fact emitted by signals.ts; passed to AI
 *   PaidRecAIOutput — Zod-validated structured response from Claude
 *   PaidRecommendationRow — DB row shape read at page render time
 */

import { z } from 'zod'

// ─── Enumerations ─────────────────────────────────────────────────────────────

export type PaidRecPlatform = 'meta' | 'google'

/** Deterministic category of the detected situation. */
export type PaidRecSignalType =
  | 'spend_no_results'   // spending ≥ threshold but 0 primary results in 7d
  | 'cpr_worsening'      // cost-per-result worsened ≥ 25% vs prior 7d
  | 'cpr_improving'      // cost-per-result improved ≥ 25% vs prior 7d
  | 'strong_performance' // result count up ≥ 30% vs prior 7d

export type PaidRecUrgency = 'high' | 'medium' | 'low'

export type PaidRecStatus = 'needs_review' | 'approved' | 'dismissed'

export type PaidRecExecutionType = 'create_task' | 'monitor' | 'create_task_and_monitor' | 'platform_action'
export type PaidRecExecutionStatus = 'pending_approval' | 'executing' | 'in_motion' | 'completed' | 'failed' | 'needs_attention'

const id = z.string().regex(/^\d{1,30}$/)
const money = z.number().positive().finite()
const base = { currency: z.string().regex(/^[A-Z]{3}$/), current_daily_budget: money, target_daily_budget: money }

/** Trusted plans are compiled server-side. They are never copied verbatim from AI output. */
export const PaidRecExecutionPlanSchema = z.discriminatedUnion('action_type', [
  z.object({ action_type: z.literal('meta_pause_campaign'), platform: z.literal('meta'), target_type: z.literal('campaign'), target_id: id, ad_account_id: z.string().regex(/^act_\d+$/), expected_current_status: z.literal('ACTIVE') }).strict(),
  z.object({ action_type: z.literal('meta_resume_campaign'), platform: z.literal('meta'), target_type: z.literal('campaign'), target_id: id, ad_account_id: z.string().regex(/^act_\d+$/), expected_current_status: z.literal('PAUSED') }).strict(),
  z.object({ action_type: z.literal('meta_pause_ad'), platform: z.literal('meta'), target_type: z.literal('ad'), target_id: id, ad_account_id: z.string().regex(/^act_\d+$/), ad_name: z.string().max(300), expected_current_status: z.literal('ACTIVE') }).strict(),
  z.object({ action_type: z.literal('meta_resume_ad'), platform: z.literal('meta'), target_type: z.literal('ad'), target_id: id, ad_account_id: z.string().regex(/^act_\d+$/), expected_current_status: z.literal('PAUSED') }).strict(),
  z.object({ action_type: z.literal('meta_pause_adset'), platform: z.literal('meta'), target_type: z.literal('adset'), target_id: id, campaign_id: id, ad_account_id: z.string().regex(/^act_\d+$/), adset_name: z.string().max(300), expected_current_status: z.literal('ACTIVE') }).strict(),
  z.object({ action_type: z.literal('meta_resume_adset'), platform: z.literal('meta'), target_type: z.literal('adset'), target_id: id, campaign_id: id, ad_account_id: z.string().regex(/^act_\d+$/), expected_current_status: z.literal('PAUSED') }).strict(),
  z.object({ action_type: z.literal('meta_set_campaign_budget'), platform: z.literal('meta'), target_type: z.literal('campaign'), target_id: id, ad_account_id: z.string().regex(/^act_\d+$/), ...base }).strict(),
  z.object({ action_type: z.literal('meta_set_adset_budget'), platform: z.literal('meta'), target_type: z.literal('adset'), target_id: id, campaign_id: id, ad_account_id: z.string().regex(/^act_\d+$/), ...base }).strict(),
  z.object({ action_type: z.literal('google_pause_campaign'), platform: z.literal('google'), customer_id: z.string().regex(/^\d{10}$/), campaign_id: id, expected_current_status: z.literal('ENABLED') }).strict(),
  z.object({ action_type: z.literal('google_resume_campaign'), platform: z.literal('google'), customer_id: z.string().regex(/^\d{10}$/), campaign_id: id, expected_current_status: z.literal('PAUSED') }).strict(),
  z.object({ action_type: z.literal('google_set_campaign_budget'), platform: z.literal('google'), customer_id: z.string().regex(/^\d{10}$/), campaign_id: id, campaign_budget_resource_name: z.string().regex(/^customers\/\d{10}\/campaignBudgets\/\d+$/), shared_budget: z.literal(false), ...base }).strict(),
  z.object({ action_type: z.literal('monitor_only'), platform: z.enum(['meta', 'google']), campaign_id: id }).strict(),
  z.object({ action_type: z.literal('run_tracking_diagnostic'), platform: z.enum(['meta', 'google']), campaign_id: id }).strict(),
  z.object({ action_type: z.literal('create_task'), platform: z.enum(['meta', 'google']), campaign_id: id, reason: z.string().min(10).max(300) }).strict(),
  z.object({ action_type: z.literal('manual_action_required'), platform: z.enum(['meta', 'google']), campaign_id: id, reason: z.string().min(10).max(300) }).strict(),
])
export type PaidRecExecutionPlan = z.infer<typeof PaidRecExecutionPlanSchema>

export const PaidRecActionIntentSchema = z.discriminatedUnion('action_type', [
  z.object({ action_type: z.enum(['pause_campaign', 'resume_campaign', 'monitor_only', 'run_tracking_diagnostic']), target_id: id }),
  z.object({ action_type: z.literal('set_daily_budget'), target_id: id, target_type: z.enum(['campaign', 'adset']), target_daily_budget: money }),
  z.object({ action_type: z.literal('create_task'), target_id: id, reason: z.string().min(10).max(300) }),
])

export interface PaidRecMonitoringResult {
  monitor_start: string
  monitor_end: string
  campaign_id: string
  platform: PaidRecPlatform
  baseline: { spend_7d: number | null; result_count_7d: number | null; cpr_7d: number | null }
  latest?: { spend_7d: number | null; result_count_7d: number | null; cpr_7d: number | null }
  outcome?: 'improved' | 'unchanged' | 'needs_attention'
}

export interface PaidRecExecutionResult {
  monitoring?: PaidRecMonitoringResult
  task_title?: string
  error?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  platform_request_id?: string
  recovery?: { mutation_may_have_succeeded: boolean; verify_before_retry: boolean }
  tracking_diagnostic?: { diagnosed: boolean; fixed: false; likely_break?: string; explanation?: string; reason?: string; evidence?: Record<string, unknown>; next_steps?: string[] }
}

/** Maps signal_type to the DEFAULT execution plan when no v2 diagnostic overrides it. */
export const SIGNAL_EXECUTION_MAP: Record<PaidRecSignalType, PaidRecExecutionType> = {
  spend_no_results:   'platform_action',
  cpr_worsening:      'platform_action',
  cpr_improving:      'monitor',
  strong_performance: 'monitor',
}

// ─── Performance diagnosis ───────────────────────────────────────────────────

export type DiagnosisClassification =
  | 'weak_ad'           // one ad materially underperforming siblings
  | 'weak_adset'        // one ad set dragging campaign while others are healthy
  | 'broad_deterioration' // performance dropped across entire campaign
  | 'tracking_suspected'  // funnel evidence suggests conversion tracking issue
  | 'insufficient_evidence' // not enough data to diagnose
  // landing_page_issue is not a first-stage classification — the tracking
  // diagnostic (tracking-diagnostic.ts) is the correct second-stage tool

export interface AdDiagnostic {
  ad_id: string
  ad_name: string
  ad_set_id: string
  status: string
  spend_current: number
  spend_prior: number
  impressions_current: number
  reach_current: number
  clicks_current: number
  ctr_current: number | null
  cpc_current: number | null
  results_current: number
  cpl_current: number | null
  results_prior: number
  cpl_prior: number | null
  frequency_current: number | null
  is_weak: boolean
}

export interface AdSetDiagnostic {
  adset_id: string
  adset_name: string
  status: string
  spend_current: number
  results_current: number
  cpl_current: number | null
  results_prior: number
  cpl_prior: number | null
  active_ad_count: number
  is_weak: boolean
  ads: AdDiagnostic[]
}

export interface PerformanceDiagnosis {
  campaign_id: string
  campaign_name: string
  classification: DiagnosisClassification
  evidence_summary: string
  ad_sets: AdSetDiagnostic[]
  weak_ad?: AdDiagnostic
  weak_adset?: AdSetDiagnostic
  healthy_sibling_count: number
}

/** Server-compiled multi-action remediation plan. Max 3 mutation actions. */
export interface PaidRemediationPlan {
  version: 'v2'
  diagnosis: PerformanceDiagnosis
  actions: PaidRecExecutionPlan[]  // max 3 mutation actions
  monitoring_days: number
  expected_outcome: string
  fallback: string | null
}

export type PaidRecExecutionType_v2 = PaidRecExecutionType | 'remediation'

// ─── Signal ───────────────────────────────────────────────────────────────────

/** Aggregated 7-day window metrics for one campaign. */
export interface PaidRecWindow {
  spend: number        // in account currency
  result_count: number
  /** Cost per result. null when result_count = 0. For AWARENESS: CPM (cost/1000 impressions). */
  cpr: number | null
}

/**
 * Deterministic signal describing a material paid-campaign situation.
 * Pure data — emitted by signals.ts, consumed by the AI caller and the orchestrator.
 * campaign_name is UNTRUSTED text from an external ad platform.
 */
export interface PaidRecSignal {
  platform: PaidRecPlatform
  campaign_id: string
  campaign_name: string  // UNTRUSTED: use DATA: prefix when sending to AI
  objective: string      // Meta objective or Google channel_type
  signal_type: PaidRecSignalType
  currency: string
  result_label: string
  current: PaidRecWindow
  prior: PaidRecWindow | null  // null = no data for the prior 7-day window
  change_pct: number | null    // fractional CPR change; null when prior unavailable or irrelevant
}

// ─── AI output ────────────────────────────────────────────────────────────────

export const PaidRecAIOutputSchema = z.object({
  recommendations: z.array(z.object({
    campaign_id:        z.string().max(100),
    platform:           z.enum(['meta', 'google']),
    what_changed:       z.string().min(10).max(200),
    evidence:           z.string().min(10).max(300),
    interpretation:     z.string().min(10).max(300),
    recommended_action: z.string().min(10).max(300),
    urgency:            z.enum(['high', 'medium', 'low']),
    action_intent:      PaidRecActionIntentSchema.optional(),
  })).max(5),
})

export type PaidRecAIOutput = z.infer<typeof PaidRecAIOutputSchema>

// ─── DB row ───────────────────────────────────────────────────────────────────

/** Shape of a row read from paid_recommendations. */
export interface PaidRecommendationRow {
  id: string
  platform: PaidRecPlatform
  campaign_id: string
  campaign_name: string
  signal_type: PaidRecSignalType
  spend_7d: number | null
  currency: string | null
  result_label: string | null
  result_count_7d: number | null
  cpr_7d: number | null
  spend_prior_7d: number | null
  result_count_prior_7d: number | null
  cpr_prior_7d: number | null
  change_pct: number | null
  what_changed: string
  evidence: string
  interpretation: string
  recommended_action: string
  urgency: PaidRecUrgency
  status: PaidRecStatus
  reviewed_at: string | null
  reviewed_by_user_id: string | null
  ai_model: string | null
  prompt_version: string | null
  generated_at: string
  created_at: string
  execution_type: PaidRecExecutionType | null
  execution_status: PaidRecExecutionStatus
  execution_started_at: string | null
  execution_completed_at: string | null
  execution_result: PaidRecExecutionResult | null
  linked_task_id: string | null
  execution_plan: PaidRecExecutionPlan | null
  execution_plan_version: string | null
  remediation_plan: PaidRemediationPlan | null
}
