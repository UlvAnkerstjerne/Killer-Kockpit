import 'server-only'
import { checkExecutionGuardrails } from './guardrails'
import { PaidRecExecutionPlanSchema, type PaidRecExecutionPlan } from './types'

export interface LivePaidTarget { platform: 'meta' | 'google'; accountId: string; status?: string; dailyBudget?: number; currency?: string; sharedBudget?: boolean }
export interface PaidMutationAdapter {
  read(plan: PaidRecExecutionPlan): Promise<LivePaidTarget>
  mutate(plan: PaidRecExecutionPlan): Promise<{ requestId?: string }>
}
export type PlanExecution =
  | { ok: true; before: LivePaidTarget; after: LivePaidTarget; requestId?: string }
  | { ok: false; status: 'failed' | 'needs_attention'; reason: string; before?: LivePaidTarget; after?: LivePaidTarget; uncertain?: boolean }

function matchesExpected(plan: PaidRecExecutionPlan, after: LivePaidTarget): boolean {
  if (plan.action_type.includes('_pause_campaign')) return after.status === 'PAUSED'
  if (plan.action_type.includes('_resume_campaign')) return after.status === (plan.platform === 'meta' ? 'ACTIVE' : 'ENABLED')
  if ('target_daily_budget' in plan) return after.dailyBudget === plan.target_daily_budget
  return true
}

/** Executes exactly one already-claimed trusted plan. Callers must persist every returned state. */
export async function executeTrustedPlan(input: unknown, adapter: PaidMutationAdapter): Promise<PlanExecution> {
  const parsed = PaidRecExecutionPlanSchema.safeParse(input)
  if (!parsed.success) return { ok: false, status: 'needs_attention', reason: 'Stored execution plan is invalid.' }
  const plan = parsed.data
  if (['monitor_only', 'run_tracking_diagnostic', 'create_task'].includes(plan.action_type)) return { ok: false, status: 'needs_attention', reason: 'Plan is not an external platform mutation.' }
  let before: LivePaidTarget
  try { before = await adapter.read(plan) } catch { return { ok: false, status: 'failed', reason: 'Could not read live state before mutation.' } }
  const guardrail = checkExecutionGuardrails(plan, before)
  if (!guardrail.ok) return { ok: false, status: 'needs_attention', reason: guardrail.reason, before }
  let result: { requestId?: string }
  try { result = await adapter.mutate(plan) } catch {
    // A timeout can occur after the remote platform committed. Never mutate again here.
    try {
      const after = await adapter.read(plan)
      if (matchesExpected(plan, after)) return { ok: true, before, after }
      return { ok: false, status: 'needs_attention', reason: 'Mutation outcome is uncertain; live state did not verify. Read state before retrying.', before, after, uncertain: true }
    } catch { return { ok: false, status: 'needs_attention', reason: 'Mutation outcome is uncertain and verification failed. Do not retry blindly.', before, uncertain: true } }
  }
  try {
    const after = await adapter.read(plan)
    if (!matchesExpected(plan, after)) return { ok: false, status: 'needs_attention', reason: 'Platform accepted the mutation but read-back did not match.', before, after }
    return { ok: true, before, after, requestId: result.requestId }
  } catch { return { ok: false, status: 'needs_attention', reason: 'Mutation was accepted but read-back failed.', before, uncertain: true } }
}
