import type { PaidRecExecutionPlan } from './types'

export const MAX_AUTOMATED_BUDGET_CHANGE = 0.25

export type GuardrailResult = { ok: true } | { ok: false; reason: string }

export function checkExecutionGuardrails(
  plan: PaidRecExecutionPlan,
  live: { platform: 'meta' | 'google'; accountId: string; status?: string; dailyBudget?: number; currency?: string; sharedBudget?: boolean },
): GuardrailResult {
  if (live.platform !== plan.platform) return { ok: false, reason: 'Platform does not match the trusted plan.' }
  if (!('ad_account_id' in plan) && !('customer_id' in plan)) return { ok: false, reason: 'Action has no external account owner.' }
  const owner = 'ad_account_id' in plan ? plan.ad_account_id : plan.customer_id
  if (live.accountId !== owner) return { ok: false, reason: 'Target does not belong to the configured account.' }
  if ('expected_current_status' in plan && live.status !== plan.expected_current_status) return { ok: false, reason: 'Status changed since approval was proposed.' }
  if ('target_daily_budget' in plan) {
    if (!live.dailyBudget || live.dailyBudget <= 0 || live.dailyBudget !== plan.current_daily_budget) return { ok: false, reason: 'Budget changed since approval was proposed.' }
    if (live.currency !== plan.currency) return { ok: false, reason: 'Currency does not match the account.' }
    if (live.sharedBudget || ('shared_budget' in plan && plan.shared_budget)) return { ok: false, reason: 'Shared budgets require manual review.' }
    if (Math.abs(plan.target_daily_budget / live.dailyBudget - 1) > MAX_AUTOMATED_BUDGET_CHANGE + Number.EPSILON) return { ok: false, reason: 'Budget change exceeds the 25% automation limit.' }
  }
  return { ok: true }
}
