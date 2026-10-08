import type { MetaIgMediaRow } from '@/lib/marketing/types/meta'
import type { CreativeFormat, Fingerprint } from './taxonomy'

export type Media = MetaIgMediaRow
export type ExposureKind = 'views' | 'reach'
export type EvidenceLevel = 'insufficient' | 'emerging' | 'supported'
export type Dimension = 'hook_type' | 'primary_theme' | 'product_focus' | 'creative_format' | 'presentation_style'
export interface MetricSummary { value: number | null; count: number }
export interface CreativePost {
  id: string
  account_id: string
  published_at: string
  synced_at: string
  permalink: string | null
  thumbnail_url: string | null
  format: CreativeFormat
  exposure_kind: ExposureKind
  exposure: number
  baseline: number | null
  baseline_count: number
  normalized_exposure: number | null
  shares: number | null
  saves: number | null
  share_rate: number | null
  save_rate: number | null
  comment_rate: number | null
  fingerprint: Pick<Fingerprint, 'hook_type' | 'hook_source' | 'primary_theme' | 'product_focus' | 'presentation_style' | 'confidence'> | null
}
export interface Pattern {
  id: string
  dimension: Dimension
  value: string
  account_id: string
  format: CreativeFormat
  exposure_kind: ExposureKind
  count: number
  normalized_exposure: MetricSummary
  share_rate: MetricSummary
  save_rate: MetricSummary
  comment_rate: MetricSummary
  evidence_level: EvidenceLevel
  supporting_media_ids: string[]
  top_media_id: string
}
export interface FormatSummary {
  account_id: string
  format: CreativeFormat
  exposure_kind: ExposureKind
  count: number
  median_exposure: number | null
  share_rate: MetricSummary
  save_rate: MetricSummary
}
export interface BusinessContextSnapshot {
  update_id: string
  project_id: string
  project_title: string
  parent_project_title: string | null
  body: string
  occurred_on: string | null
  created_at: string
  age_days: number
}
export interface CreativeAnalytics {
  window: { start: string; end: string }
  posts: CreativePost[]
  patterns: Pattern[]
  formats: FormatSummary[]
  exceptional: CreativePost[]
  coverage: { total: number; with_exposure: number; classified: number; stale_syncs: number }
  /** Business context items available during this run. Absent for older runs. */
  business_context?: BusinessContextSnapshot[]
  /** v2: Brain's short top-level synthesis. Absent for runs generated before the v2 interpretation. */
  brain_take?: string | null
}
export const SIGNAL_TYPES = ['hook_outperformance', 'theme_outperformance', 'product_outperformance', 'presentation_outperformance', 'share_heavy_pattern', 'save_heavy_pattern', 'format_outperformance', 'exceptional_post'] as const
export type SignalType = typeof SIGNAL_TYPES[number]
export interface CreativeSignal {
  id: string
  type: SignalType
  dimension: Dimension
  value: string
  account_id: string
  format: CreativeFormat
  exposure_kind: ExposureKind
  sample_size: number
  metric: 'normalized_exposure' | 'share_rate' | 'save_rate' | 'exposure'
  current: number
  baseline: number
  comparison: string
  comparison_sample_size: number
  supporting_media_ids: string[]
  comparison_media_ids: string[]
  evidence_level: 'emerging' | 'supported' | 'individual'
}
export interface ObservationBusinessContext {
  update_id: string
  project_title: string
  occurred_on: string | null
  excerpt: string
  role: 'proof_point' | 'timely_angle' | 'case_study' | 'subject_matter'
}
export interface Observation {
  signal_id: string
  finding: string
  evidence: string
  interpretation: string
  suggested_experiment: string
  /** Optional business context from a Universal Update. Null/absent for older runs. */
  business_context?: ObservationBusinessContext | null
}
/** v2 interpretation: one conclusion that may synthesise 1–4 related deterministic signals. */
export interface Insight {
  signal_ids: string[]
  headline: string
  take: string
  next_move: string
  /** Up to two Universal Updates used as creative material (never performance evidence). */
  business_context?: ObservationBusinessContext[]
}
/** A persisted run holds legacy one-signal observations (v1) or v2 insights. */
export type StoredObservation = Observation | Insight
export function isInsight(o: StoredObservation): o is Insight {
  return Array.isArray((o as Insight).signal_ids)
}
export interface ClassificationCounts { eligible: number; classified: number; skipped: number; failed: number; deferred: number }
export interface CreativeRun {
  id: string
  generated_at: string
  analysis_start: string
  analysis_end: string
  model: string | null
  prompt_version: string
  classification_version: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  analytics: CreativeAnalytics | null
  signals: CreativeSignal[]
  observations: StoredObservation[]
  classification_counts: ClassificationCounts
  error: string | null
}
