/**
 * CMO Insights — shared types.
 *
 * Four things stay DISTINCT but linkable:
 *   signal          deterministic, per run, never durable (creative signals, brief signals, the paid evidence pack)
 *   insight         a durable conclusion the specialist analyses reached, kept across runs (marketing_insights)
 *   recommendation  something to do, owned by Paid Strategy (marketing_paid_strategy_runs)
 *   action / result the human decision and its execution (marketing_paid_strategy_implementations)
 *
 * An insight points at its sources (refs), its history (observations) and the recommendations it informed or was
 * derived from (links). It never copies recommendation or action state.
 */

import type { PaidStrategyRecommendationType } from '@/lib/marketing/paid-strategy/types'

export const INSIGHT_DOMAINS = ['paid', 'organic', 'creative'] as const
export type InsightDomain = (typeof INSIGHT_DOMAINS)[number]

export const INSIGHT_KINDS = ['finding', 'content_opportunity', 'retargeting_hypothesis'] as const
export type InsightKind = (typeof INSIGHT_KINDS)[number]

/**
 * One scale across sources. `hypothesis` is an idea nobody has tested (all Paid Strategy output); the rest follow the
 * organic labels. Creative signals map conservatively (see extract.ts).
 */
export const INSIGHT_STRENGTHS = ['strong_pattern', 'reasonable_inference', 'weak_signal', 'hypothesis'] as const
export type InsightStrength = (typeof INSIGHT_STRENGTHS)[number]

export const INSIGHT_TRENDS = ['new', 'strengthening', 'steady', 'weakening', 'unconfirmed'] as const
export type InsightTrend = (typeof INSIGHT_TRENDS)[number]

export const INSIGHT_STATUSES = ['active', 'stale'] as const
export type InsightStatus = (typeof INSIGHT_STATUSES)[number]

export const OBSERVATION_CHANGES = ['new', 'strengthened', 'reconfirmed', 'weakened'] as const
export type ObservationChange = (typeof OBSERVATION_CHANGES)[number]

export type InsightSourceKind = 'creative_run' | 'paid_strategy_run'

/** Where a statement came from. Structured so evidence can be inspected; free text alone cannot be. */
export type SourceRef =
  | { type: 'instagram_post'; ref: string | null; permalink: string | null; published_at: string | null; media_type: string | null }
  | { type: 'creative_signal'; signal_id: string; sample_size: number; evidence_level: string }
  | { type: 'paid_strategy_run'; run_id: string; index: number; window_start: string; window_end: string }

export interface InsightCandidate {
  domain: InsightDomain
  kind: InsightKind
  /** Matching only ever happens inside one scope. */
  scope_key: string
  /** Exact identity when the source offers one (creative: the sorted signal ids). Null otherwise. */
  stable_key: string | null
  title: string
  statement: string
  evidence_text: string | null
  limitations: string | null
  /** A creative suggestion, kept apart from the statement so it is never read as a finding. */
  suggestion: string | null
  strength: InsightStrength
  refs: SourceRef[]
  /** Paid insights remember which recommendation they came from. Null for the other sources. */
  recommendation_index: number | null
}

export interface InsightRow {
  id: string
  domain: InsightDomain
  kind: InsightKind
  scope_key: string
  stable_key: string | null
  title: string
  statement: string
  evidence_text: string | null
  limitations: string | null
  suggestion: string | null
  strength: InsightStrength
  peak_strength: InsightStrength
  trend: InsightTrend
  status: InsightStatus
  times_observed: number
  runs_since_seen: number
  first_seen_at: string
  last_seen_at: string
  last_supported_at: string
  /** The latest source run that touched this insight (observed OR missed). Makes every write idempotent per run. */
  last_source_run_id: string | null
  refs: SourceRef[]
  created_at: string
  updated_at: string
}

export type InsightInsert = Omit<InsightRow, 'id' | 'created_at' | 'updated_at'>
export type InsightPatch = Partial<Omit<InsightRow, 'id' | 'created_at'>>

export interface ObservationRow {
  insight_id: string
  source_kind: InsightSourceKind
  source_run_id: string
  source_index: number | null
  observed_at: string
  strength: InsightStrength
  change: ObservationChange
  statement: string
  evidence_text: string | null
  limitations: string | null
  refs: SourceRef[]
}

export type LinkTarget = 'paid_strategy_recommendation' | 'paid_strategy_run' | 'creative_run'
export interface LinkRow {
  insight_id: string
  target_type: LinkTarget
  target_run_id: string
  target_index: number | null
  relation: 'derived_from' | 'informed'
}

/** What one source run says. `coverage` names the domains whose absence from this run actually means something. */
export interface RunExtraction {
  sourceKind: InsightSourceKind
  runId: string
  observedAt: string
  candidates: InsightCandidate[]
  coverage: Partial<Record<InsightDomain, boolean>>
}

export const STRENGTH_RANK: Record<InsightStrength, number> = { strong_pattern: 3, reasonable_inference: 2, weak_signal: 1, hypothesis: 1 }
export const STRENGTH_LABEL: Record<InsightStrength, string> = {
  strong_pattern: 'Strong repeated pattern', reasonable_inference: 'Reasonable inference', weak_signal: 'Weak signal', hypothesis: 'Untested hypothesis',
}
export const TREND_LABEL: Record<InsightTrend, string> = {
  new: 'New', strengthening: 'Gaining support', steady: 'Holding', weakening: 'Losing support', unconfirmed: 'Not seen in the latest run',
}
export const DOMAIN_LABEL: Record<InsightDomain, string> = { paid: 'Paid', organic: 'Organic', creative: 'Creative' }
export const KIND_LABEL: Record<InsightKind, string> = {
  finding: 'Finding', content_opportunity: 'Content opportunity', retargeting_hypothesis: 'Retargeting hypothesis',
}

export type { PaidStrategyRecommendationType }
