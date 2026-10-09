/**
 * Paid Strategy implementation — shared types (executor-first, v2).
 *
 * MESPER decides WHAT is worth doing (advisory text, unchanged). Kockpit decides HOW and does the digital work itself.
 * A human is asked only for a decision, an access grant, or a physical act, and always for the exact thing.
 * Nothing here is read from model output except the stored recommendation prose and the creative WORDS:
 * every ID, status, budget and currency is resolved server-side from synced data or Meta reads.
 */

import { z } from 'zod'
import type { PaidRecExecutionPlan } from '@/lib/marketing/paid-recs/types'
import type { Blocker } from '../autonomous/types'

export const IMPLEMENTATION_MODES = ['platform_action', 'tracking_execution', 'creative_execution', 'campaign_creation', 'needs_input'] as const
export type ImplementationMode = (typeof IMPLEMENTATION_MODES)[number]

/**
 * prepared / needs_input   compiled and shown; nothing has happened
 * approved                 atomically claimed, budget reserved
 * planning / executing / verifying   Kockpit is working (visible only while it runs or after an interruption)
 * waiting_for_access       a capability is missing: the exact missing thing is shown
 * waiting_for_input        a decision or a physical act is needed: the exact thing is shown
 * ready_to_activate        everything exists, verified and PAUSED; activation needs its own approval
 * in_motion                a platform change is live and monitored
 * completed                finished and verified
 * needs_attention          uncertain or unexpected state; nothing is retried blindly
 * failed                   nothing was changed; can be approved again
 * cancelled                released; reservation freed (objects already created stay paused in Meta)
 * started                  kept for rows created by v1
 */
export const IMPLEMENTATION_STATUSES = [
  'prepared', 'needs_input', 'approved', 'planning', 'executing', 'verifying', 'waiting_for_input', 'waiting_for_access',
  'ready_to_activate', 'started', 'in_motion', 'completed', 'cancelled', 'needs_attention', 'failed',
] as const
export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number]

/** Statuses whose reserved budget still counts against the shared strategy headroom (mirrors paid_strategy_reserved_dkk()). */
export const RESERVING_STATUSES: readonly ImplementationStatus[] = ['approved', 'planning', 'executing', 'verifying', 'waiting_for_input', 'waiting_for_access', 'ready_to_activate', 'started', 'in_motion', 'needs_attention']
/** Statuses from which Kockpit can continue after a blocker is cleared, or an interruption. */
export const RESUMABLE_STATUSES: readonly ImplementationStatus[] = ['waiting_for_input', 'waiting_for_access', 'needs_attention']
export const IN_FLIGHT_STATUSES: readonly ImplementationStatus[] = ['approved', 'planning', 'executing', 'verifying']
export const CANCELLABLE_STATUSES: readonly ImplementationStatus[] = ['prepared', 'needs_input', 'waiting_for_input', 'waiting_for_access', 'ready_to_activate', 'needs_attention', 'failed']

export const PlatformChoiceSchema = z.object({
  action: z.enum(['pause_campaign', 'resume_campaign', 'set_daily_budget']),
  targetType: z.enum(['campaign', 'adset']),
  targetId: z.string().regex(/^\d{1,30}$/),
  targetDailyBudget: z.number().positive().finite().max(100000).optional(),
}).strict()

/** The only things a browser may send. Anything else is rejected (strict). No platform IDs except a synced target the person picked. */
export const ImplementationInputsSchema = z.object({
  ownerUserId: z.string().uuid().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  platform: PlatformChoiceSchema.optional(),
  campaign: z.object({
    dailyBudgetDkk: z.number().positive().finite().max(15000).optional(),
    durationDays: z.number().int().min(1).max(60).optional(),
  }).strict().optional(),
}).strict()
export type ImplementationInputs = z.infer<typeof ImplementationInputsSchema>

export interface InputRequirement {
  key: 'platform_target' | 'platform_action' | 'platform_budget' | 'daily_budget' | 'duration' | 'reserve_budget'
  label: string
  detail?: string
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

export interface SpendPlan { dailyBudgetDkk: number; durationDays: number; totalDkk: number }

export interface CompiledImplementation {
  mode: ImplementationMode
  /** The mode this would be once the missing inputs are supplied (equals mode otherwise). */
  intendedMode: ImplementationMode
  headline: string
  /** What Kockpit will do itself. */
  willDo: string[]
  willNot: string[]
  /** What a person will be asked for, and why Kockpit cannot do it. Empty when nothing is expected. */
  peopleNeeded: string[]
  /** Blockers already known from capability discovery: the preview says up front where this will stop. */
  expectedBlockers: Blocker[]
  /** Creates objects in Meta (always PAUSED). */
  changesMeta: boolean
  budget: BudgetView
  missing: InputRequirement[]
  spend: SpendPlan | null
  market: string | null
  platform: PlatformPreview | null
  referencedCampaigns: { ref: string; name: string }[]
}

/** What the UI is allowed to know about one implementation. No compiled plan and no platform IDs. */
export interface ImplementationView {
  id: string
  strategyRunId: string
  recommendationIndex: number
  mode: ImplementationMode
  status: ImplementationStatus
  budgetReservedDkk: number
  error: string | null
  approvedAt: string | null
  blockers: Blocker[]
  /** The latest human-readable result line from the executor. */
  message: string | null
  /** Present when ready_to_activate: exactly what activation would switch on. */
  review: ActivationReview | null
  linkedTaskId: string | null
}

export interface ActivationReview {
  kind: 'campaign' | 'creative'
  title: string
  lines: { label: string; value: string }[]
  notes: string[]
}
