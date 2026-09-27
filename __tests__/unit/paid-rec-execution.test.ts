import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { PaidRecExecutionPlanSchema } from '@/lib/marketing/paid-recs/types'
import { compileExecutionPlan, type SyncedTarget, type ConfiguredAccounts } from '@/lib/marketing/paid-recs/compile-plan'
import { checkExecutionGuardrails } from '@/lib/marketing/paid-recs/guardrails'
import { executeTrustedPlan, type LivePaidTarget } from '@/lib/marketing/paid-recs/executor'

const metaPlan = { action_type: 'meta_set_campaign_budget', platform: 'meta', target_type: 'campaign', target_id: '123', ad_account_id: 'act_42', currency: 'DKK', current_daily_budget: 300, target_daily_budget: 240 } as const

describe('paid recommendation plans', () => {
  it.each([
    { action_type: 'meta_pause_campaign', platform: 'meta', target_type: 'campaign', target_id: '1', ad_account_id: 'act_2', expected_current_status: 'ACTIVE' },
    { action_type: 'meta_resume_campaign', platform: 'meta', target_type: 'campaign', target_id: '1', ad_account_id: 'act_2', expected_current_status: 'PAUSED' },
    metaPlan,
    { ...metaPlan, action_type: 'meta_set_adset_budget', target_type: 'adset', campaign_id: '77' },
    { action_type: 'google_pause_campaign', platform: 'google', customer_id: '1234567890', campaign_id: '1', expected_current_status: 'ENABLED' },
    { action_type: 'google_resume_campaign', platform: 'google', customer_id: '1234567890', campaign_id: '1', expected_current_status: 'PAUSED' },
    { action_type: 'google_set_campaign_budget', platform: 'google', customer_id: '1234567890', campaign_id: '1', campaign_budget_resource_name: 'customers/1234567890/campaignBudgets/9', shared_budget: false, currency: 'DKK', current_daily_budget: 100, target_daily_budget: 120 },
    { action_type: 'monitor_only', platform: 'meta', campaign_id: '1' },
    { action_type: 'run_tracking_diagnostic', platform: 'google', campaign_id: '1' },
    { action_type: 'create_task', platform: 'meta', campaign_id: '1', reason: 'Requires a person to update the landing page.' },
  ])('accepts allowlisted plan $action_type', plan => expect(PaidRecExecutionPlanSchema.safeParse(plan).success).toBe(true))

  it('rejects arbitrary payloads and wrong targets/platforms', () => {
    expect(PaidRecExecutionPlanSchema.safeParse({ action_type: 'delete_campaign', payload: { anything: true } }).success).toBe(false)
    expect(compileExecutionPlan({ action_type: 'pause_campaign', target_id: '999' }, { platform: 'meta', campaignId: '123', accountId: 'act_42', status: 'ACTIVE', currency: 'DKK' }).ok).toBe(false)
    expect(PaidRecExecutionPlanSchema.safeParse({ ...metaPlan, platform: 'google' }).success).toBe(false)
  })
})

// ─── Ownership / account verification ─────────────────────────────────────

describe('ownership verification at compile time', () => {
  const metaTarget: SyncedTarget = { platform: 'meta', campaignId: '123', accountId: 'act_42', status: 'ACTIVE', currency: 'DKK', dailyBudget: 300 }
  const googleTarget: SyncedTarget = { platform: 'google', campaignId: '456', accountId: '8582465933', status: 'ENABLED', currency: 'DKK', dailyBudget: 100, campaignBudgetResourceName: 'customers/8582465933/campaignBudgets/9', sharedBudget: false }
  const configured: ConfiguredAccounts = { metaAdAccountId: 'act_42', googleCustomerId: '8582465933' }

  it('accepts Meta target matching configured account', () => {
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '123' }, metaTarget, configured)
    expect(result.ok).toBe(true)
  })

  it('rejects Meta target from wrong ad account', () => {
    const wrongTarget = { ...metaTarget, accountId: 'act_999' }
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '123' }, wrongTarget, configured)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('configured Meta ad account')
  })

  it('accepts Google target matching configured customer', () => {
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '456' }, googleTarget, configured)
    expect(result.ok).toBe(true)
  })

  it('rejects Google target from wrong customer', () => {
    const wrongTarget = { ...googleTarget, accountId: '9999999999' }
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '456' }, wrongTarget, configured)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('configured Google Ads customer')
  })

  it('rejects Google shared budget at compile time', () => {
    const sharedTarget = { ...googleTarget, sharedBudget: true }
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '456', target_type: 'campaign', target_daily_budget: 80 }, sharedTarget, configured)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('Shared budgets')
  })

  it('still compiles Meta when no configuredAccounts provided', () => {
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '123' }, metaTarget)
    expect(result.ok).toBe(true)
  })

  it('accepts Google customer with hyphenated format', () => {
    const hyphenConfigured: ConfiguredAccounts = { googleCustomerId: '858-246-5933' }
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '456' }, googleTarget, hyphenConfigured)
    expect(result.ok).toBe(true)
  })

  it('rejects Google mutation when googleCustomerId is undefined (fail closed)', () => {
    const noGoogle: ConfiguredAccounts = { metaAdAccountId: 'act_42' }
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '456' }, googleTarget, noGoogle)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('not configured')
  })

  it('rejects Google mutation when configuredAccounts is omitted entirely', () => {
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '456' }, googleTarget)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('not configured')
  })

  it('rejects Google mutation when googleCustomerId is empty string', () => {
    const empty: ConfiguredAccounts = { googleCustomerId: '' }
    const result = compileExecutionPlan({ action_type: 'pause_campaign', target_id: '456' }, googleTarget, empty)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('not configured')
  })

  it('allows Google non-mutation (monitor_only) without configured customer', () => {
    const result = compileExecutionPlan({ action_type: 'monitor_only', target_id: '456' }, googleTarget)
    expect(result.ok).toBe(true)
  })

  it('allows Google non-mutation (run_tracking_diagnostic) without configured customer', () => {
    const result = compileExecutionPlan({ action_type: 'run_tracking_diagnostic', target_id: '456' }, googleTarget)
    expect(result.ok).toBe(true)
  })
})

// ─── Budget plan compilation ──────────────────────────────────────────────

describe('budget plan compilation', () => {
  const metaBudgetTarget: SyncedTarget = { platform: 'meta', campaignId: '123', accountId: 'act_42', status: 'ACTIVE', currency: 'DKK', dailyBudget: 300 }

  it('compiles Meta campaign budget with correct currency propagation', () => {
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '123', target_type: 'campaign', target_daily_budget: 240 }, metaBudgetTarget)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan).toMatchObject({
        action_type: 'meta_set_campaign_budget',
        platform: 'meta',
        currency: 'DKK',
        current_daily_budget: 300,
        target_daily_budget: 240,
        ad_account_id: 'act_42',
      })
    }
  })

  it('compiles Meta adset budget correctly', () => {
    const adsetTarget = { ...metaBudgetTarget, adSetId: '777' }
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '777', target_type: 'adset', target_daily_budget: 250 }, adsetTarget)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan).toMatchObject({
        action_type: 'meta_set_adset_budget',
        target_type: 'adset',
        target_id: '777',
        campaign_id: '123',
      })
    }
  })

  it('compiles Google budget with campaign_budget_resource_name', () => {
    const googleTarget: SyncedTarget = { platform: 'google', campaignId: '456', accountId: '8582465933', status: 'ENABLED', currency: 'DKK', dailyBudget: 100, campaignBudgetResourceName: 'customers/8582465933/campaignBudgets/9', sharedBudget: false }
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '456', target_type: 'campaign', target_daily_budget: 80 }, googleTarget, { googleCustomerId: '8582465933' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan).toMatchObject({
        action_type: 'google_set_campaign_budget',
        customer_id: '8582465933',
        campaign_budget_resource_name: 'customers/8582465933/campaignBudgets/9',
        shared_budget: false,
        currency: 'DKK',
        current_daily_budget: 100,
        target_daily_budget: 80,
      })
    }
  })

  it('rejects >25% budget change at compile time', () => {
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '123', target_type: 'campaign', target_daily_budget: 180 }, metaBudgetTarget)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('25%')
  })

  it('rejects stale budget (zero daily budget)', () => {
    const staleTarget = { ...metaBudgetTarget, dailyBudget: 0 }
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '123', target_type: 'campaign', target_daily_budget: 100 }, staleTarget)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('no daily budget')
  })

  it('rejects Google budget when resource name missing', () => {
    const googleNoBudget: SyncedTarget = { platform: 'google', campaignId: '456', accountId: '8582465933', status: 'ENABLED', currency: 'DKK', dailyBudget: 100 }
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '456', target_type: 'campaign', target_daily_budget: 80 }, googleNoBudget, { googleCustomerId: '8582465933' })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('resource name')
  })

  it('rejects ambiguous/missing currency', () => {
    const noCurrency = { ...metaBudgetTarget, currency: '' }
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '123', target_type: 'campaign', target_daily_budget: 240 }, noCurrency)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('currency')
  })

  it('accepts exactly 25% change', () => {
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '123', target_type: 'campaign', target_daily_budget: 225 }, metaBudgetTarget)
    expect(result.ok).toBe(true)
  })

  it('percentage calculation: 300 DKK × -20% = 240 DKK accepted', () => {
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '123', target_type: 'campaign', target_daily_budget: 240 }, metaBudgetTarget)
    expect(result.ok).toBe(true)
  })

  it('percentage calculation: 300 DKK × -40% = 180 DKK rejected', () => {
    const result = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '123', target_type: 'campaign', target_daily_budget: 180 }, metaBudgetTarget)
    expect(result.ok).toBe(false)
  })
})

describe('paid mutation guardrails', () => {
  const live: LivePaidTarget = { platform: 'meta', accountId: 'act_42', dailyBudget: 300, currency: 'DKK' }
  it('accepts a 20% budget reduction', () => expect(checkExecutionGuardrails(metaPlan, live).ok).toBe(true))
  it('rejects over 25%, stale, non-positive and wrong-account budgets', () => {
    expect(checkExecutionGuardrails({ ...metaPlan, target_daily_budget: 224 }, live).ok).toBe(false)
    expect(checkExecutionGuardrails(metaPlan, { ...live, dailyBudget: 301 }).ok).toBe(false)
    expect(PaidRecExecutionPlanSchema.safeParse({ ...metaPlan, target_daily_budget: 0 }).success).toBe(false)
    expect(checkExecutionGuardrails(metaPlan, { ...live, accountId: 'act_99' }).ok).toBe(false)
  })
  it('rejects wrong Meta ad account at runtime', () => {
    const wrongLive = { ...live, accountId: 'act_999' }
    const result = checkExecutionGuardrails(metaPlan, wrongLive)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('does not belong')
  })
  it('rejects wrong Google customer at runtime', () => {
    const googlePlan = { action_type: 'google_set_campaign_budget', platform: 'google', customer_id: '1234567890', campaign_id: '1', campaign_budget_resource_name: 'customers/1234567890/campaignBudgets/9', shared_budget: false, currency: 'DKK', current_daily_budget: 100, target_daily_budget: 120 } as const
    const wrongGoogleLive: LivePaidTarget = { platform: 'google', accountId: '0000000000', dailyBudget: 100, currency: 'DKK' }
    const result = checkExecutionGuardrails(googlePlan, wrongGoogleLive)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('does not belong')
  })
  it('rejects shared budgets at runtime', () => {
    const googlePlan = { action_type: 'google_set_campaign_budget', platform: 'google', customer_id: '1234567890', campaign_id: '1', campaign_budget_resource_name: 'customers/1234567890/campaignBudgets/9', shared_budget: false, currency: 'DKK', current_daily_budget: 100, target_daily_budget: 120 } as const
    const sharedLive: LivePaidTarget = { platform: 'google', accountId: '1234567890', dailyBudget: 100, currency: 'DKK', sharedBudget: true }
    const result = checkExecutionGuardrails(googlePlan, sharedLive)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('Shared budgets')
  })
})

describe('execution and recovery', () => {
  it('mutates once and verifies read-back', async () => {
    const read = vi.fn().mockResolvedValueOnce({ platform: 'meta', accountId: 'act_42', dailyBudget: 300, currency: 'DKK' }).mockResolvedValueOnce({ platform: 'meta', accountId: 'act_42', dailyBudget: 240, currency: 'DKK' })
    const mutate = vi.fn().mockResolvedValue({ requestId: 'request-1' })
    expect((await executeTrustedPlan(metaPlan, { read, mutate })).ok).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(1)
  })
  it('does not re-mutate when a timeout may have committed', async () => {
    const read = vi.fn().mockResolvedValueOnce({ platform: 'meta', accountId: 'act_42', dailyBudget: 300, currency: 'DKK' }).mockResolvedValueOnce({ platform: 'meta', accountId: 'act_42', dailyBudget: 240, currency: 'DKK' })
    const mutate = vi.fn().mockRejectedValue(new Error('timeout'))
    expect((await executeTrustedPlan(metaPlan, { read, mutate })).ok).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(1)
  })
  it('marks verification mismatch for attention', async () => {
    const read = vi.fn().mockResolvedValue({ platform: 'meta', accountId: 'act_42', dailyBudget: 300, currency: 'DKK' })
    const result = await executeTrustedPlan(metaPlan, { read, mutate: vi.fn().mockResolvedValue({}) })
    expect(result).toMatchObject({ ok: false, status: 'needs_attention' })
  })
})
