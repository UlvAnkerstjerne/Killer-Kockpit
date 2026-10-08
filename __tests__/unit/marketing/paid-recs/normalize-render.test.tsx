// Regression: production /marketing/paid crashed ("This page couldn't load") because a v2 row stores its
// plan in execution_plan ({version:'v2', actions:[...]}, no action_type) and the UI called
// execution_plan.action_type.includes(...) on it.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }))
vi.mock('@/lib/actions/marketing/paid-recommendations', () => ({
  approvePaidRecommendation: vi.fn(), dismissPaidRecommendation: vi.fn(), createTaskForManualCase: vi.fn(),
}))

import PaidRecsSection from '@/app/(marketing)/marketing/paid/PaidRecsSection'
import { normalizePaidRecommendation } from '@/lib/marketing/paid-recs/normalize'
import type { PaidRecommendationRow } from '@/lib/marketing/paid-recs/types'

function row(over: Record<string, unknown>): PaidRecommendationRow {
  return {
    id: 'r1', platform: 'meta', campaign_id: 'c1', campaign_name: 'Camp', signal_type: 'cpr_worsening',
    spend_7d: 100, currency: 'DKK', result_label: 'Leads', result_count_7d: 2, cpr_7d: 50, spend_prior_7d: 100,
    result_count_prior_7d: 4, cpr_prior_7d: 25, change_pct: 100, what_changed: 'w', evidence: 'e', interpretation: 'i',
    recommended_action: 'a', urgency: 'high', status: 'needs_review', reviewed_at: null, reviewed_by_user_id: null,
    ai_model: null, prompt_version: null, generated_at: '2026-10-08T00:00:00Z', created_at: '2026-10-08T00:00:00Z',
    execution_type: 'platform_action', execution_status: 'pending_approval', execution_started_at: null,
    execution_completed_at: null, execution_result: null, linked_task_id: null,
    execution_plan_version: 'v2', ...over,
  } as unknown as PaidRecommendationRow
}

const v2 = {
  version: 'v2', monitoring_days: 5, expected_outcome: 'x', fallback: null,
  diagnosis: { evidence_summary: 'Ad set underperforming' },
  actions: [{ action_type: 'meta_set_adset_budget', platform: 'meta', target_id: '1', currency: 'DKK', current_daily_budget: 100, target_daily_budget: 80 }],
}

describe('v2 plans stored in execution_plan', () => {
  it('normalize moves a v2 plan to remediation_plan', () => {
    const n = normalizePaidRecommendation(row({ execution_plan: v2 }))
    expect(n.execution_plan).toBeNull()
    expect(n.remediation_plan?.actions).toHaveLength(1)
  })

  it('renders the production row shape without throwing', () => {
    const html = renderToStaticMarkup(<PaidRecsSection recommendations={[normalizePaidRecommendation(row({ execution_plan: v2 }))]} canAction />)
    expect(html).toContain('Camp')
    expect(html).toContain('100 → 80 DKK/day')
  })

  it('does not throw even if an un-normalised or malformed plan reaches the UI', () => {
    expect(() => renderToStaticMarkup(<PaidRecsSection recommendations={[row({ execution_plan: v2 })]} canAction />)).not.toThrow()
    expect(() => renderToStaticMarkup(<PaidRecsSection recommendations={[row({ execution_plan: {}, execution_plan_version: null })]} canAction />)).not.toThrow()
    expect(() => renderToStaticMarkup(<PaidRecsSection recommendations={[normalizePaidRecommendation(row({ execution_plan: {} }))]} canAction />)).not.toThrow()
  })

  it('keeps v1 plans untouched', () => {
    const plan = { platform: 'meta', target_id: '1', action_type: 'meta_pause_campaign', target_type: 'campaign' }
    const n = normalizePaidRecommendation(row({ execution_plan: plan, execution_plan_version: 'v1' }))
    expect(n.execution_plan).toEqual(plan)
    expect(renderToStaticMarkup(<PaidRecsSection recommendations={[n]} canAction />)).toContain('Pause Meta campaign')
  })
})
