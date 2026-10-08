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

/**
 * Constrained decoding cannot enforce string length, so the model is TOLD the targets
 * (see KOCKPIT_RULES) and the schema keeps headroom above them. Without headroom a
 * mild overshoot in one field discards an otherwise valid analysis (seen live: the
 * first run failed because several fields ran 3-25% over a hard cap the model never saw).
 */
export const FIELD_TARGET_CHARS = {
  title: 120, evidence: 600, interpretation: 500, hypothesis: 400,
  exact_test_or_action: 700, success_metric: 300, evidence_limitations: 500,
} as const
export const FIELD_MAX_CHARS = {
  title: 160, evidence: 900, interpretation: 800, hypothesis: 600,
  exact_test_or_action: 1000, success_metric: 450, evidence_limitations: 800,
} as const

export const PaidStrategyRecommendationSchema = z.object({
  title: z.string().min(5).max(FIELD_MAX_CHARS.title),
  recommendation_type: z.enum(RECOMMENDATION_TYPES),
  /** FACTS only: numbers and structure present in the supplied data. */
  evidence: z.string().min(10).max(FIELD_MAX_CHARS.evidence),
  /** INFERENCE: what the facts might mean. Never stated as established. */
  interpretation: z.string().min(10).max(FIELD_MAX_CHARS.interpretation),
  hypothesis: z.string().min(10).max(FIELD_MAX_CHARS.hypothesis),
  exact_test_or_action: z.string().min(10).max(FIELD_MAX_CHARS.exact_test_or_action),
  /** Extra DKK this test needs ON TOP of existing spend. All recommendations draw on the SAME projected headroom. */
  incremental_budget_dkk: z.number().min(0).describe('Extra DKK spend this test needs on top of existing spend. 0 if it is funded by reallocating existing spend or needs no spend. The sum across all recommendations must not exceed budget.projection.projected_incremental_headroom; must be 0 when that is null.'),
  success_metric: z.string().min(5).max(FIELD_MAX_CHARS.success_metric),
  evidence_limitations: z.string().min(5).max(FIELD_MAX_CHARS.evidence_limitations),
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
  evidence?: { budget?: { monthly_ceiling?: number; month_to_date_spend?: number; currency?: string; projection?: { projected_month_end_spend?: number; projected_incremental_headroom?: number | null; reliable?: boolean } }; data_gaps?: string[] } | null
  /** Rows written before incremental_budget_dkk existed lack that field. */
  recommendations: (Omit<PaidStrategyRecommendation, 'incremental_budget_dkk'> & { incremental_budget_dkk?: number })[]
  error: string | null
}
