/**
 * Organic Strategy — shared types and structured-output schema.
 *
 * A second strategic layer on top of Creative Intelligence. Creative Intelligence stays the
 * evidence layer (meta_ig_media, fingerprints, deterministic analytics and signals); this layer
 * answers "what should Killer Kebab make next, based on what has actually worked organically?".
 *
 * Advisory text only. No IDs, no payloads, nothing executable.
 */

import { z } from 'zod'

export const EVIDENCE_STRENGTHS = ['proven_pattern', 'reasonable_inference', 'weak_signal'] as const
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number]

export const MAX_LEARNINGS = 5
export const MAX_OPPORTUNITIES = 5
export const MAX_REELS = 3
export const MAX_CAROUSELS = 6
export const MAX_SLIDES = 10

/**
 * Constrained decoding cannot enforce string length, so the model is TOLD the targets
 * (see ORGANIC_RULES) and the schema keeps headroom above them. Without headroom a mild
 * overshoot in one field discards an otherwise valid analysis (learned the hard way in
 * Paid Strategy v1).
 */
export const FIELD_TARGET_CHARS = {
  title: 100, evidence: 500, interpretation: 400, limitations: 250,
  why_now: 300, evidence_basis: 300, suggested_angle: 400,
  hook: 200, core_idea: 350, execution: 700, why_worth_testing: 350,
  opening_slide: 200, slide: 160,
} as const
export const FIELD_MAX_CHARS = {
  title: 140, evidence: 800, interpretation: 650, limitations: 450,
  why_now: 500, evidence_basis: 500, suggested_angle: 650,
  hook: 320, core_idea: 550, execution: 1100, why_worth_testing: 550,
  opening_slide: 320, slide: 260,
} as const
const M = FIELD_MAX_CHARS

const strength = z.enum(EVIDENCE_STRENGTHS)

export const MainLearningSchema = z.object({
  title: z.string().min(5).max(M.title),
  /** EVIDENCE: what actually happened in the supplied data. Facts and numbers only, with post refs. */
  evidence: z.string().min(10).max(M.evidence),
  /** INFERENCE: what the evidence reasonably suggests. Hedged; never causal. */
  interpretation: z.string().min(10).max(M.interpretation),
  evidence_strength: strength,
  limitations: z.string().min(5).max(M.limitations),
}).strict()

export const ContentOpportunitySchema = z.object({
  title: z.string().min(5).max(M.title),
  why_now: z.string().min(10).max(M.why_now),
  evidence_basis: z.string().min(10).max(M.evidence_basis),
  /** CREATIVE SUGGESTION: something to try, not something proven. */
  suggested_angle: z.string().min(10).max(M.suggested_angle),
  evidence_strength: strength,
}).strict()

export const ReelConceptSchema = z.object({
  concept_title: z.string().min(5).max(M.title),
  hook: z.string().min(5).max(M.hook),
  core_idea: z.string().min(10).max(M.core_idea),
  execution: z.string().min(20).max(M.execution),
  why_this_is_worth_testing: z.string().min(10).max(M.why_worth_testing),
  evidence_basis: z.string().min(10).max(M.evidence_basis),
}).strict()

export const CarouselConceptSchema = z.object({
  concept_title: z.string().min(5).max(M.title),
  opening_slide: z.string().min(5).max(M.opening_slide),
  slide_structure: z.array(z.string().min(5).max(M.slide)).min(2).max(MAX_SLIDES),
  why_this_is_worth_testing: z.string().min(10).max(M.why_worth_testing),
  evidence_basis: z.string().min(10).max(M.evidence_basis),
}).strict()

/** Empty arrays are valid: the strategist must not fill slots to reach the maximum. */
export const OrganicStrategyOutputSchema = z.object({
  main_learnings: z.array(MainLearningSchema).max(MAX_LEARNINGS),
  content_opportunities: z.array(ContentOpportunitySchema).max(MAX_OPPORTUNITIES),
  reel_concepts: z.array(ReelConceptSchema).max(MAX_REELS),
  carousel_concepts: z.array(CarouselConceptSchema).max(MAX_CAROUSELS),
}).strict()

export type MainLearning = z.infer<typeof MainLearningSchema>
export type ContentOpportunity = z.infer<typeof ContentOpportunitySchema>
export type ReelConcept = z.infer<typeof ReelConceptSchema>
export type CarouselConcept = z.infer<typeof CarouselConceptSchema>
export type OrganicStrategyOutput = z.infer<typeof OrganicStrategyOutputSchema>

export type OrganicStrategyStatus = 'completed' | 'unavailable' | 'skipped'

export interface OrganicStrategyPostRef {
  ref: string
  published_at: string
  media_type: string
  permalink: string | null
}

/**
 * Stored inside marketing_creative_intelligence_runs.analytics under `organic_strategy`.
 * Absent on runs created before this feature (backwards compatible).
 */
export interface OrganicStrategyStored {
  /** completed = output present; unavailable = the specialist call failed (retry on next refresh); skipped = not enough data to try. */
  status: OrganicStrategyStatus
  generated_at: string
  model: string | null
  prompt_version: string
  skill: { name: string; version: string; ref: string; hash: string } | null
  evidence_window: { first_published: string | null; last_published: string | null; as_of: string }
  evidence_summary: {
    stored_posts: number
    measured_posts: number
    unmeasured_posts: number
    measured_in_prompt: number
    unmeasured_in_prompt: number
    business_context_items: number
  }
  /** Reference table so the UI can show which posts P1..Pn / U1..Un mean. Never sent as IDs to the model. */
  posts: OrganicStrategyPostRef[]
  quality: { strength_downgrades: number; unmatched_figures: string[] }
  output: OrganicStrategyOutput | null
  /** User-safe explanation when status is unavailable or skipped. */
  message: string | null
}
