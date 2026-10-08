// Normalises a paid_recommendations row for the UI.
//
// v2 remediation plans are persisted in the `execution_plan` JSONB column
// (execution_plan_version = 'v2', shape { version, diagnosis, actions[], ... }).
// There is no `remediation_plan` column — the UI-facing `remediation_plan` field is derived here.
// Without this, v2 rows reach code that expects execution_plan.action_type and crash the page.

import type { PaidRecommendationRow, PaidRemediationPlan } from './types'

function isV2Plan(p: unknown): p is PaidRemediationPlan {
  return !!p && typeof p === 'object'
    && (p as { version?: unknown }).version === 'v2'
    && Array.isArray((p as { actions?: unknown }).actions)
}

export function normalizePaidRecommendation(row: PaidRecommendationRow): PaidRecommendationRow {
  const plan = row.execution_plan as unknown
  if (isV2Plan(plan)) {
    return { ...row, remediation_plan: plan, execution_plan: null }
  }
  // Anything else that is not a v1 plan (object with a string action_type) is unusable: treat as no plan.
  const hasV1Shape = !!plan && typeof plan === 'object' && typeof (plan as { action_type?: unknown }).action_type === 'string'
  return { ...row, remediation_plan: row.remediation_plan ?? null, execution_plan: hasV1Shape ? row.execution_plan : null }
}
