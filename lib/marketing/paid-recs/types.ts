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
}
