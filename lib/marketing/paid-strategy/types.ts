/**
 * Paid Strategy (MESPER) — shared types.
 *
 * Strategic, ADVISORY recommendations about structure, audiences, creative, copy,
 * budget, tracking and funnel. Deliberately has no campaign_id / payload fields:
 * nothing here can be executed. Operational changes to existing campaigns stay in
 * the Paid Recommendations / Needs Review flow (lib/marketing/paid-recs).
 */

import { z } from 'zod'

export const RECOMMENDATION_TYPES = [
  'campaign_structure', 'retargeting', 'audience', 'creative', 'copy', 'budget', 'tracking', 'funnel',
] as const
export type PaidStrategyRecommendationType = (typeof RECOMMENDATION_TYPES)[number]

export const MAX_RECOMMENDATIONS = 3

export const PaidStrategyRecommendationSchema = z.object({
  title: z.string().min(5).max(120),
  recommendation_type: z.enum(RECOMMENDATION_TYPES),
  /** FACTS only: numbers and structure present in the supplied data. */
  evidence: z.string().min(10).max(600),
  /** INFERENCE: what the facts might mean. Never stated as established. */
  interpretation: z.string().min(10).max(500),
  hypothesis: z.string().min(10).max(400),
  exact_test_or_action: z.string().min(10).max(700),
  success_metric: z.string().min(5).max(300),
  evidence_limitations: z.string().min(5).max(500),
}).strict()

export const PaidStrategyOutputSchema = z.object({
  recommendations: z.array(PaidStrategyRecommendationSchema).max(MAX_RECOMMENDATIONS),
}).strict()

export type PaidStrategyRecommendation = z.infer<typeof PaidStrategyRecommendationSchema>
export type PaidStrategyOutput = z.infer<typeof PaidStrategyOutputSchema>

export type PaidStrategyRunStatus = 'running' | 'completed' | 'failed'

/** Row shape of marketing_paid_strategy_runs as read by the UI. */
export interface PaidStrategyRun {
  id: string
  started_at: string
  generated_at: string
  status: PaidStrategyRunStatus
  window_start: string
  window_end: string
  model: string | null
  prompt_version: string
  skill_ref: string
  skill_hash: string
  /** The exact evidence sent to the model (no platform IDs). Omitted when listing previous runs. */
  evidence?: { budget?: { monthly_ceiling?: number; month_to_date_spend?: number; currency?: string }; data_gaps?: string[] } | null
  recommendations: PaidStrategyRecommendation[]
  error: string | null
}
