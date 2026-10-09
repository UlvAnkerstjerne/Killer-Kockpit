/**
 * Paid Strategy implementation — shared types.
 *
 * MESPER decides WHAT is worth doing (advisory text, unchanged). Kockpit decides HOW it can be
 * implemented safely. Nothing here is read from model output except the stored recommendation prose:
 * every ID, status, budget and currency is resolved server-side from synced Kockpit data, and every
 * platform change is compiled by the existing trusted compiler (paid-recs/compile-plan).
 */

import { z } from 'zod'
import type { PaidRecExecutionPlan } from '@/lib/marketing/paid-recs/types'

export const IMPLEMENTATION_MODES = ['platform_action', 'implementation_task', 'creative_task', 'implementation_package', 'needs_input'] as const
export type ImplementationMode = (typeof IMPLEMENTATION_MODES)[number]

/**
 * prepared        compiled and shown; nothing has happened
 * needs_input     the smallest missing inputs are listed; compile again once supplied
 * approved        atomically claimed; the side effect is in flight (budget reserved)
 * started         work handed to people (task created / package persisted). NOT "done"
 * in_motion       a platform change is applied and being monitored
 * completed       the linked task is done, or the platform change is finished
 * cancelled       the linked task was cancelled; reservation released
 * needs_attention uncertain outcome; a person must look before anything is retried
 * failed          nothing was changed; reservation released; can be approved again
 */
export const IMPLEMENTATION_STATUSES = ['prepared', 'needs_input', 'approved', 'started', 'in_motion', 'completed', 'cancelled', 'needs_attention', 'failed'] as const
export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number]

/** Statuses whose reserved budget still counts against the shared strategy headroom. */
export const RESERVING_STATUSES: readonly ImplementationStatus[] = ['approved', 'started', 'in_motion', 'needs_attention']

/** The only things a browser may send. Anything else is rejected (strict). */
export const PlatformChoiceSchema = z.object({
  action: z.enum(['pause_campaign', 'resume_campaign', 'set_daily_budget']),
  targetType: z.enum(['campaign', 'adset']),
  /** Chosen from the synced-targets list; the server re-resolves it and rejects anything it cannot find. */
  targetId: z.string().regex(/^\d{1,30}$/),
  targetDailyBudget: z.number().positive().finite().max(100000).optional(),
}).strict()

export const ImplementationInputsSchema = z.object({
  ownerUserId: z.string().uuid().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Incremental paid budget to set aside. Can lower, never raise, the amount the strategy proposed. */
  reserveBudgetDkk: z.number().min(0).max(15000).finite().optional(),
  platform: PlatformChoiceSchema.optional(),
  package: z.object({
    location: z.string().trim().max(120).optional(),
    landingPage: z.string().trim().max(200).optional(),
    leadForm: z.string().trim().max(200).optional(),
    conversionEvent: z.string().trim().max(120).optional(),
    asset: z.string().trim().max(200).optional(),
  }).strict().optional(),
}).strict()
export type ImplementationInputs = z.infer<typeof ImplementationInputsSchema>

export interface InputRequirement {
  key: 'platform_target' | 'platform_action' | 'platform_budget' | 'reserve_budget' | 'location'
  label: string
  detail?: string
}

export interface TaskDraft { title: string; description: string; priority: 1 | 2 | 3 }

export interface ImplementationPackage {
  version: 'v1'
  kind: 'new_campaign' | 'new_audience_structure' | 'retargeting_structure'
  objective: string
  market: string | null
  campaign_purpose: string
  recommended_structure: string
  starting_budget_note: string
  maximum_incremental_budget_dkk: number
  success_metric: string
  /** Server-resolved from synced data via the model's local C-ref; null when it cannot be resolved unambiguously. */
  source_campaign_to_mirror: { id: string; name: string } | null
  must_still_be_confirmed: string[]
  required_creative_assets: string[]
  required_tracking: string[]
  /** Explicit in the stored package so nobody mistakes a package for a launched campaign. */
  not_done_by_kockpit: string[]
}

export interface PlatformPreview {
  plan: PaidRecExecutionPlan
  targetLabel: string
  actionLabel: string
  before: string
  after: string
  /** Extra DKK the change can add before month end (increases only). */
  incrementalDkk: number
}

export interface BudgetView {
  proposedDkk: number
  requestedDkk: number
  reliable: boolean
  /** Shared headroom minus budget already reserved by other active implementations. null = no reliable headroom. */
  availableDkk: number | null
  reservedByOthersDkk: number
  projectedHeadroomDkk: number | null
}

export interface CompiledImplementation {
  mode: ImplementationMode
  /** The mode this would be once the missing inputs are supplied (equals mode otherwise). */
  intendedMode: Exclude<ImplementationMode, 'needs_input'>
  headline: string
  willDo: string[]
  willNot: string[]
  needsPerson: string[]
  cannotAutomate: string[]
  changesMeta: boolean
  budget: BudgetView
  missing: InputRequirement[]
  task: TaskDraft | null
  package: ImplementationPackage | null
  platform: PlatformPreview | null
  /** References kept for the card and the audit trail (never executable). */
  referencedCampaigns: { ref: string; name: string }[]
}

/** What the UI is allowed to know about one implementation. No compiled plan, no IDs of platform objects. */
export interface ImplementationView {
  id: string
  strategyRunId: string
  recommendationIndex: number
  mode: ImplementationMode
  status: ImplementationStatus
  linkedTaskId: string | null
  linkedTaskStatus: string | null
  ownerName: string | null
  budgetReservedDkk: number
  error: string | null
  approvedAt: string | null
}
