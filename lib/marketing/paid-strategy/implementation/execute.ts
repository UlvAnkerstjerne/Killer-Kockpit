/**
 * The single side effect of a CLAIMED implementation. The database has already admitted it exactly once and
 * reserved its budget, so a second click never reaches this file.
 *
 *   task / creative / package -> one Kockpit task through the existing audited task RPC
 *   platform action           -> the existing trusted executor (guardrails, live re-read, verified read-back)
 *
 * Nothing here retries an external mutation, and nothing reports "launched" for work that was only handed to a person.
 */

import 'server-only'
import type { createServiceClient } from '@/lib/supabase/server'
import { PaidRecExecutionPlanSchema } from '@/lib/marketing/paid-recs/types'
import { recordImplementationAudit } from './audit'
import type { StoredRecommendation } from './compile'
import type { CompiledImplementation, ImplementationStatus } from './types'
import type { ConfirmOutcome } from './service'

type Db = ReturnType<typeof createServiceClient>
const TABLE = 'marketing_paid_strategy_implementations'

export interface ClaimedImplementation {
  id: string; actorId: string; runId: string; index: number
  compiled: CompiledImplementation; ownerUserId: string; dueDate: string
  recommendation: StoredRecommendation; budgetReservedDkk: number
}

async function settle(db: Db, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const res = await db.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'approved').select('id').maybeSingle()
  return !res.error && !!res.data
}

async function fail(db: Db, c: ClaimedImplementation, status: Extract<ImplementationStatus, 'failed' | 'needs_attention'>, error: string, result?: Record<string, unknown>): Promise<ConfirmOutcome> {
  await settle(db, c.id, { status, error: error.slice(0, 500), ...(result ? { result } : {}) })
  await recordImplementationAudit(db, c.actorId, status, c.id, { strategy_run_id: c.runId, recommendation_index: c.index, mode: c.compiled.mode, error: error.slice(0, 300), budget_reserved_dkk: status === 'failed' ? 0 : c.budgetReservedDkk })
  return { ok: false, error: status === 'failed' ? `${error} Nothing was changed.` : `${error} A person needs to check this before anything is retried.` }
}

export async function executeClaimedImplementation(db: Db, c: ClaimedImplementation): Promise<ConfirmOutcome> {
  if (c.compiled.mode === 'platform_action') return executePlatform(db, c)
  if (!c.compiled.task) return fail(db, c, 'failed', 'The task could not be prepared.')

  const { normalizeTaskCreateInput, insertTaskWithAudit } = await import('@/lib/domain/task-creation')
  const normalized = normalizeTaskCreateInput({
    title: c.compiled.task.title, description: c.compiled.task.description, owner_user_id: c.ownerUserId,
    priority: c.compiled.task.priority, due_at: new Date(`${c.dueDate}T12:00:00Z`).toISOString(),
  }, c.actorId)
  if (!normalized.ok) return fail(db, c, 'failed', 'The task could not be prepared.')
  const created = await insertTaskWithAudit(db, c.actorId, normalized.data)
  if (created.error || !created.id) return fail(db, c, 'failed', 'The task could not be created.')

  const now = new Date().toISOString()
  const saved = await settle(db, c.id, { status: 'started', linked_task_id: created.id, started_at: now, error: null })
  if (!saved) {
    // The task exists but its link did not save. Keep the reservation, flag it, and never create a second task.
    await db.from(TABLE).update({ status: 'needs_attention', linked_task_id: created.id, error: 'The task was created but its link could not be saved.', updated_at: now }).eq('id', c.id)
  }
  await recordImplementationAudit(db, c.actorId, 'started', c.id, {
    strategy_run_id: c.runId, recommendation_index: c.index, mode: c.compiled.mode, linked_task_id: created.id,
    budget_reserved_dkk: c.budgetReservedDkk, owner_user_id: c.ownerUserId, due_date: c.dueDate, package_saved: !!c.compiled.package,
  })
  return { ok: true, duplicate: false, status: saved ? 'started' : 'needs_attention', linkedTaskId: created.id, message: c.compiled.package ? 'Launch package saved and implementation task created. Nothing was created in Meta.' : 'Implementation task created. Nothing was changed in Meta.' }
}

async function executePlatform(db: Db, c: ClaimedImplementation): Promise<ConfirmOutcome> {
  // Re-validate the stored plan with the trusted schema; refuse anything that is not an existing-object Meta change.
  const parsed = PaidRecExecutionPlanSchema.safeParse(c.compiled.platform?.plan)
  if (!parsed.success || parsed.data.platform !== 'meta') return fail(db, c, 'needs_attention', 'The stored change is not a supported Meta change.')
  const plan = parsed.data

  const { executeTrustedPlan } = await import('@/lib/marketing/paid-recs/executor')
  const { metaMutationAdapter } = await import('@/lib/marketing/paid-recs/platform-adapters')
  const currency = 'currency' in plan ? plan.currency : 'DKK'
  const result = await executeTrustedPlan(plan, metaMutationAdapter(currency))
  if (!result.ok) {
    return fail(db, c, result.status, result.reason, {
      before: result.before, after: result.after,
      ...(result.uncertain ? { recovery: { mutation_may_have_succeeded: true, verify_before_retry: true } } : {}),
    })
  }

  const isStatusToggle = plan.action_type.includes('pause') || plan.action_type.includes('resume')
  const now = new Date().toISOString()
  const status: ImplementationStatus = isStatusToggle ? 'completed' : 'in_motion'
  const saved = await settle(db, c.id, {
    status, started_at: now, ...(isStatusToggle ? { completed_at: now } : {}), error: null,
    result: { before: result.before, after: result.after, platform_request_id: result.requestId ?? null, action_type: plan.action_type },
  })
  await recordImplementationAudit(db, c.actorId, 'executed', c.id, {
    strategy_run_id: c.runId, recommendation_index: c.index, mode: c.compiled.mode, action_type: plan.action_type,
    platform: 'meta', before: result.before, after: result.after, budget_reserved_dkk: c.budgetReservedDkk, result_saved: saved,
  })
  return { ok: true, duplicate: false, status, message: 'The change was applied and verified by reading it back from Meta.' }
}
