/**
 * Glue between an admitted (claimed) implementation and the execution state machine in ../autonomous/runner.
 *
 * The database has already admitted the implementation exactly once and reserved its budget, so a second click never
 * reaches this file. Every state change the runner makes is persisted as it happens (status + the step ledger), so an
 * interruption leaves a resumable record rather than a mystery.
 *
 * A person appears here in exactly one place: createHandoffTask, used only when new footage is genuinely required.
 */

import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { PaidRecExecutionPlanSchema } from '@/lib/marketing/paid-recs/types'
import { recordImplementationAudit } from './audit'
import type { CompileInput, StoredRecommendation } from './compile'
import { detectMarket } from './compile'
import type { CompiledImplementation, ImplementationMode, ImplementationStatus } from './types'
import { runActivation, runCampaignCreation, runCreativeExecution, runTrackingExecution, type RunContext, type RunnerDeps, type RunResult, type RunStatus } from '../autonomous/runner'
import { emptyLedger, type ExecutionLedger } from '../autonomous/types'
import type { ConfirmOutcome } from './service'

type Db = ReturnType<typeof createServiceClient>
const TABLE = 'marketing_paid_strategy_implementations'
export const SITE_URL = 'https://www.killerkebab.com/catering'

export interface Claim {
  id: string; actorId: string; runId: string; index: number
  compiled: CompiledImplementation; recommendation: StoredRecommendation
  ownerUserId: string; dueDate: string
  /** Budget reserved by the claim: the ceiling the run may never exceed. */
  budgetReservedDkk: number
  ledger?: ExecutionLedger
}

export const tokenFor = (implementationId: string) => `KK-${implementationId.replace(/-/g, '').slice(0, 8)}`

async function persist(db: Db, id: string, status: RunStatus, ledger: ExecutionLedger) {
  const message = typeof ledger.evidence.message === 'string' ? ledger.evidence.message.slice(0, 500) : null
  const patch: Record<string, unknown> = { status, execution: ledger, updated_at: new Date().toISOString(), error: status === 'needs_attention' || status === 'failed' ? message : null }
  if (status === 'in_motion' || status === 'completed') patch.started_at = new Date().toISOString()
  if (status === 'completed') patch.completed_at = new Date().toISOString()
  const res = await db.from(TABLE).update(patch).eq('id', id).select('id').maybeSingle()
  if (res.error) console.error('[paid-strategy/implementation] could not persist state:', res.error.message)
}

/** Everything the runner needs about the world, resolved by the SERVER from synced data and the compiled preview. */
export function buildRunContext(db: Db, claim: Claim, input: CompileInput, ledger: ExecutionLedger): RunContext {
  const ref = claim.compiled.referencedCampaigns.length === 1 ? claim.compiled.referencedCampaigns[0] : null
  const source = ref ? input.campaigns.find(c => c.name === ref.name) : undefined
  return {
    ledger, rec: { title: claim.recommendation.title, hypothesis: claim.recommendation.hypothesis, exact_test_or_action: claim.recommendation.exact_test_or_action, success_metric: claim.recommendation.success_metric, incremental_budget_dkk: claim.recommendation.incremental_budget_dkk },
    configuredAccountId: input.configuredMetaAdAccountId,
    source: source ? { campaignId: source.id, accountId: source.ad_account_id, name: source.name, currency: source.currency } : null,
    market: claim.compiled.market, sourceMarket: source ? detectMarket(source.name) : null,
    syncedCampaigns: input.campaigns.map(c => ({ id: c.id, name: c.name, accountId: c.ad_account_id })),
    approvedIncrementalDkk: claim.budgetReservedDkk, dailyBudgetDkk: claim.compiled.spend?.dailyBudgetDkk ?? null, durationDays: claim.compiled.spend?.durationDays ?? null,
    ownerUserId: claim.ownerUserId, dueDate: claim.dueDate,
    save: async (status, l) => persist(db, claim.id, status, l),
  }
}

export interface ProductionPorts { deps: RunnerDeps }

export async function runClaimed(db: Db, deps: RunnerDeps, claim: Claim, input: CompileInput): Promise<ConfirmOutcome> {
  const ledger = claim.ledger ?? emptyLedger(tokenFor(claim.id))
  const mode = claim.compiled.mode as ImplementationMode
  let result: RunResult
  if (mode === 'platform_action') return executePlatform(db, deps, claim)
  const ctx = buildRunContext(db, claim, input, ledger)
  if (mode === 'campaign_creation') result = await runCampaignCreation(ctx, deps)
  else if (mode === 'creative_execution') result = await runCreativeExecution(ctx, deps)
  else if (mode === 'tracking_execution') result = await runTrackingExecution(ctx, deps, SITE_URL)
  else return { ok: false, error: 'This recommendation cannot be implemented yet.' }
  return outcomeOf(db, claim, result)
}

async function outcomeOf(db: Db, claim: Claim, r: RunResult): Promise<ConfirmOutcome> {
  const action = r.status === 'waiting_for_access' || r.status === 'waiting_for_input' ? 'blocked' : r.status === 'ready_to_activate' ? 'ready_to_activate' : r.status === 'failed' ? 'failed' : r.status === 'needs_attention' ? 'needs_attention' : 'executed'
  await recordImplementationAudit(db, claim.actorId, action, claim.id, {
    strategy_run_id: claim.runId, recommendation_index: claim.index, mode: claim.compiled.mode, status: r.status, message: r.message.slice(0, 300),
    budget_reserved_dkk: claim.budgetReservedDkk, blockers: r.blockers.map(b => ({ kind: b.kind, code: b.code, capability: b.capability })),
    steps: r.ledger.steps.map(s => ({ key: s.key, status: s.status })),
  })
  if (r.status === 'failed') return { ok: false, error: `${r.message}` }
  return { ok: true, duplicate: false, status: r.status as ImplementationStatus, message: r.message, blockers: r.blockers }
}

/** Existing-object Meta change through the unchanged trusted executor: guardrails, live re-read, verified read-back, no retry. */
async function executePlatform(db: Db, deps: RunnerDeps, claim: Claim): Promise<ConfirmOutcome> {
  const parsed = PaidRecExecutionPlanSchema.safeParse(claim.compiled.platform?.plan)
  if (!parsed.success || parsed.data.platform !== 'meta') return fail(db, claim, 'needs_attention', 'The stored change is not a supported Meta change.')
  const plan = parsed.data
  const result = await deps.executePlan(plan)
  if (!result.ok) {
    await persistPlatform(db, claim.id, result.status, { before: result.before, after: result.after, ...(result.uncertain ? { recovery: { mutation_may_have_succeeded: true, verify_before_retry: true } } : {}) }, result.reason)
    await recordImplementationAudit(db, claim.actorId, result.status, claim.id, { strategy_run_id: claim.runId, recommendation_index: claim.index, mode: 'platform_action', error: result.reason.slice(0, 300) })
    return { ok: false, error: result.status === 'failed' ? `${result.reason} Nothing was changed.` : `${result.reason} A person needs to check this before anything is retried.` }
  }
  const toggle = plan.action_type.includes('pause') || plan.action_type.includes('resume')
  const status: ImplementationStatus = toggle ? 'completed' : 'in_motion'
  await persistPlatform(db, claim.id, status, { before: result.before, after: result.after, platform_request_id: result.requestId ?? null, action_type: plan.action_type }, null)
  await recordImplementationAudit(db, claim.actorId, 'executed', claim.id, { strategy_run_id: claim.runId, recommendation_index: claim.index, mode: 'platform_action', action_type: plan.action_type, platform: 'meta', before: result.before, after: result.after, budget_reserved_dkk: claim.budgetReservedDkk })
  return { ok: true, duplicate: false, status, message: 'The change was applied and verified by reading it back from Meta.' }
}

async function persistPlatform(db: Db, id: string, status: ImplementationStatus, result: Record<string, unknown>, error: string | null) {
  const now = new Date().toISOString()
  await db.from(TABLE).update({ status, result, error: error ? error.slice(0, 500) : null, updated_at: now, started_at: status === 'in_motion' || status === 'completed' ? now : null, completed_at: status === 'completed' ? now : null }).eq('id', id)
}
async function fail(db: Db, claim: Claim, status: 'failed' | 'needs_attention', error: string): Promise<ConfirmOutcome> {
  await persistPlatform(db, claim.id, status, {}, error)
  await recordImplementationAudit(db, claim.actorId, status, claim.id, { strategy_run_id: claim.runId, recommendation_index: claim.index, error: error.slice(0, 300) })
  return { ok: false, error }
}

/** Activation: a separate approval, re-verified, through the trusted executor. */
export async function activateClaimed(db: Db, deps: RunnerDeps, row: { id: string; mode: ImplementationMode; ledger: ExecutionLedger; durationDays: number | null; configuredAccountId: string; actorId: string; runId: string; index: number }): Promise<ConfirmOutcome> {
  const r = await runActivation({
    ledger: row.ledger, configuredAccountId: row.configuredAccountId, durationDays: row.durationDays, mode: row.mode === 'campaign_creation' ? 'campaign_creation' : 'creative_execution',
    save: async (status, l) => persist(db, row.id, status, l),
  }, deps)
  await recordImplementationAudit(db, row.actorId, r.status === 'in_motion' ? 'activated' : 'needs_attention', row.id, { strategy_run_id: row.runId, recommendation_index: row.index, mode: row.mode, status: r.status, message: r.message.slice(0, 300), steps: r.ledger.steps.map(s => ({ key: s.key, status: s.status })) })
  if (r.status === 'in_motion') await db.from('marketing_paid_strategy_creative_drafts').update({ approval_state: 'approved', updated_at: new Date().toISOString() }).eq('implementation_id', row.id)
  return r.status === 'in_motion' ? { ok: true, duplicate: false, status: 'in_motion', message: r.message } : { ok: false, error: r.message }
}
