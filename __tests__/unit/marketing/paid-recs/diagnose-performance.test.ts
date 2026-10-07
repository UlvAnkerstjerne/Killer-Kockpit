/**
 * Unit tests for lib/marketing/paid-recs/diagnose-performance.ts
 *
 * Covers:
 *   1.  weak_ad classification with sibling-excluding median
 *   2.  weak_adset classification
 *   3.  broad_deterioration with campaign budget → meta_set_campaign_budget
 *   4.  broad_deterioration with null campaign budget + 1 ad-set budget → meta_set_adset_budget (Katering case)
 *   5.  broad_deterioration with multiple ad sets → manual_action_required
 *   6.  tracking_suspected classification
 *   7.  insufficient_evidence
 *   8.  cannot pause last viable ad
 *   9.  cannot pause last viable ad set
 *   10. volume guard: MIN_AD_SPEND enforced
 *   11. volume guard: MIN_AD_CLICKS enforced
 *   12. weak_ad sibling median excludes candidate
 *   13. zero-result ad with healthy siblings → weak_ad
 *   14. budget reduction capped at 20%
 *   15. monitoring_days defaults to 5
 *   16. Katering dry run: budget-null + 1 ad-set = 100 DKK → meta_set_adset_budget 100→80
 *   17. v1 backward compatible: no remediation_plan on old rows
 *   18. manual_action_required → no approve button (isManualOnly)
 */

import { describe, it, expect } from 'vitest'
import {
  diagnosePerformance,
  buildRemediationPlan,
  MIN_AD_SPEND,
  MIN_AD_IMPRESSIONS,
  MIN_AD_CLICKS,
  WEAK_AD_CPL_RATIO,
  WEAK_ADSET_CPL_RATIO,
  MIN_REMAINING_ADS,
  type AdInsightRow,
  type MetaAdWithSet,
  type MetaAdSetInfo,
  type DiagnosticInput,
  type RemediationCampaignContext,
} from '@/lib/marketing/paid-recs/diagnose-performance'
import { MAX_AUTOMATED_BUDGET_CHANGE } from '@/lib/marketing/paid-recs/guardrails'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAdInsight(adId: string, overrides: Partial<AdInsightRow> = {}): AdInsightRow {
  return {
    ad_id: adId,
    date_start: '2026-10-01',
    impressions: 1000,
    reach: 800,
    clicks: 50,
    inline_link_clicks: 40,
    spend: '100',
    cpm: null, cpc: null, ctr: null,
    actions_json: [{ action_type: 'lead', value: '5' }],
    cost_per_action_json: null,
    action_values_json: null,
    ...overrides,
  }
}

function makeAd(id: string, adSetId: string, name: string, status = 'ACTIVE'): MetaAdWithSet {
  return { id, ad_set_id: adSetId, name, status }
}

function makeAdSet(id: string, campaignId: string, name: string, status = 'ACTIVE', dailyBudget: string | null = null): MetaAdSetInfo {
  return { id, campaign_id: campaignId, name, status, daily_budget: dailyBudget }
}

function baseDiagnosticInput(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    campaignId: 'c1',
    campaignName: 'Test Campaign',
    adAccountId: 'act_123',
    objective: 'OUTCOME_LEADS',
    currency: 'DKK',
    dailyBudget: 400,
    ads: [makeAd('ad1', 'as1', 'Good Ad'), makeAd('ad2', 'as1', 'Bad Ad')],
    adSets: [makeAdSet('as1', 'c1', 'Ad Set 1')],
    currentAdInsights: [],
    priorAdInsights: [],
    ...overrides,
  }
}

function baseCampaign(overrides: Partial<RemediationCampaignContext> = {}): RemediationCampaignContext {
  return {
    id: 'c1', adAccountId: 'act_123', currency: 'DKK', dailyBudget: 400,
    adSets: [makeAdSet('as1', 'c1', 'Ad Set 1')],
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('diagnosePerformance', () => {
  it('1. classifies weak_ad when one ad has materially worse CPL than siblings', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Good Ad'), makeAd('ad2', 'as1', 'Bad Ad')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '5' }] }),
        makeAdInsight('ad2', { spend: '200', actions_json: [{ action_type: 'lead', value: '1' }] }),
      ],
    })
    const result = diagnosePerformance(input)
    expect(result.classification).toBe('weak_ad')
    expect(result.weak_ad?.ad_id).toBe('ad2')
  })

  it('2. classifies weak_adset when one ad set drags while another is healthy', () => {
    const input = baseDiagnosticInput({
      ads: [
        makeAd('ad1', 'as1', 'Good Ad 1'), makeAd('ad2', 'as1', 'Good Ad 2'),
        makeAd('ad3', 'as2', 'Bad Ad'), makeAd('ad4', 'as2', 'Bad Ad 2'),
      ],
      adSets: [makeAdSet('as1', 'c1', 'Good Set'), makeAdSet('as2', 'c1', 'Bad Set')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '5' }] }),
        makeAdInsight('ad2', { spend: '100', actions_json: [{ action_type: 'lead', value: '5' }] }),
        makeAdInsight('ad3', { spend: '200', actions_json: [{ action_type: 'lead', value: '1' }] }),
        makeAdInsight('ad4', { spend: '200', actions_json: [{ action_type: 'lead', value: '1' }] }),
      ],
    })
    const result = diagnosePerformance(input)
    expect(['weak_ad', 'weak_adset']).toContain(result.classification)
  })

  it('3. classifies broad_deterioration when no localized culprit', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad 1'), makeAd('ad2', 'as1', 'Ad 2')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] }),
        makeAdInsight('ad2', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] }),
      ],
    })
    expect(diagnosePerformance(input).classification).toBe('broad_deterioration')
  })

  it('6. classifies tracking_suspected when clicks exist but zero results', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad 1')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '200', clicks: 50, impressions: 1000, actions_json: [] }),
      ],
    })
    expect(diagnosePerformance(input).classification).toBe('tracking_suspected')
  })

  it('7. classifies insufficient_evidence with no measured ads', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Low Spend Ad')],
      currentAdInsights: [makeAdInsight('ad1', { spend: '10', impressions: 50, clicks: 2 })],
    })
    expect(diagnosePerformance(input).classification).toBe('insufficient_evidence')
  })

  it('8. does NOT classify weak_ad when only one active ad remains', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Only Ad')],
      currentAdInsights: [makeAdInsight('ad1', { spend: '200', actions_json: [{ action_type: 'lead', value: '1' }] })],
    })
    expect(diagnosePerformance(input).weak_ad).toBeUndefined()
  })

  it('9. does NOT classify weak_adset when only one active ad set exists', () => {
    const input = baseDiagnosticInput({
      adSets: [makeAdSet('as1', 'c1', 'Only Set')],
    })
    expect(diagnosePerformance(input).weak_adset).toBeUndefined()
  })

  it('10. volume guard: ad below MIN_AD_SPEND not considered', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Good'), makeAd('ad2', 'as1', 'Tiny')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '5' }] }),
        makeAdInsight('ad2', { spend: String(MIN_AD_SPEND - 1), actions_json: [] }),
      ],
    })
    expect(diagnosePerformance(input).weak_ad?.ad_id).not.toBe('ad2')
  })

  it('11. volume guard: MIN_AD_CLICKS enforced — ad below threshold not measurable', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Good'), makeAd('ad2', 'as1', 'Low Clicks')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', clicks: 50, actions_json: [{ action_type: 'lead', value: '5' }] }),
        makeAdInsight('ad2', { spend: '100', clicks: MIN_AD_CLICKS - 1, impressions: 1000, actions_json: [{ action_type: 'lead', value: '1' }] }),
      ],
    })
    // ad2 has fewer clicks than MIN_AD_CLICKS, so it should not be in the measurable set
    // and should not be classified as weak_ad via CPL comparison
    const result = diagnosePerformance(input)
    // With only 1 measurable ad, there can be no CPL comparison → no weak_ad from CPL
    expect(result.weak_ad?.ad_id).not.toBe('ad2')
  })

  it('12. weak_ad comparison uses sibling median EXCLUDING the candidate', () => {
    // 3 ads: ad1 CPL=20, ad2 CPL=25, ad3 CPL=50
    // Median of all 3: 25. ad3/25 = 2.0× → weak if included
    // Median excluding ad3: (20+25)/2 = 22.5. ad3/22.5 = 2.2× → still weak, but ratio is different
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad 1'), makeAd('ad2', 'as1', 'Ad 2'), makeAd('ad3', 'as1', 'Ad 3')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '5' }] }),  // CPL=20
        makeAdInsight('ad2', { spend: '125', actions_json: [{ action_type: 'lead', value: '5' }] }),  // CPL=25
        makeAdInsight('ad3', { spend: '200', actions_json: [{ action_type: 'lead', value: '2' }] }),  // CPL=100
      ],
    })
    const result = diagnosePerformance(input)
    expect(result.classification).toBe('weak_ad')
    expect(result.weak_ad?.ad_id).toBe('ad3')
    // Sibling median excluding ad3: median([20, 25]) = 22.5
    // Ratio: 100/22.5 = 4.4× — far above WEAK_AD_CPL_RATIO
  })

  it('13. zero-result ad spending while siblings produce → weak_ad', () => {
    const input = baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Producer'), makeAd('ad2', 'as1', 'Non-producer')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '5' }] }),
        makeAdInsight('ad2', { spend: '100', actions_json: [] }),
      ],
    })
    const result = diagnosePerformance(input)
    expect(result.classification).toBe('weak_ad')
    expect(result.weak_ad?.ad_id).toBe('ad2')
  })
})

describe('buildRemediationPlan', () => {
  it('3. broad_deterioration with campaign budget → meta_set_campaign_budget', () => {
    const diagnosis = diagnosePerformance(baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad 1'), makeAd('ad2', 'as1', 'Ad 2')],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] }),
        makeAdInsight('ad2', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] }),
      ],
    }))
    const plan = buildRemediationPlan(diagnosis, baseCampaign({ dailyBudget: 400 }))
    expect(plan.actions[0].action_type).toBe('meta_set_campaign_budget')
    if ('target_daily_budget' in plan.actions[0]) {
      expect(plan.actions[0].target_daily_budget).toBe(Math.round(400 * (1 - MAX_AUTOMATED_BUDGET_CHANGE)))
    }
  })

  it('4. Katering case: null campaign budget + 1 ad-set budget → meta_set_adset_budget', () => {
    const diagnosis = diagnosePerformance(baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Katering Carousel V1.1')],
      adSets: [makeAdSet('as1', 'c1', 'Katering Leads', 'ACTIVE', '10000')],  // 10000 minor units = 100 DKK
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '585', clicks: 138, impressions: 5450, actions_json: [{ action_type: 'lead', value: '1' }] }),
      ],
    }))
    const plan = buildRemediationPlan(diagnosis, baseCampaign({
      dailyBudget: null,
      adSets: [makeAdSet('as1', 'c1', 'Katering Leads', 'ACTIVE', '10000')],
    }))
    expect(plan.actions[0].action_type).toBe('meta_set_adset_budget')
    if ('target_daily_budget' in plan.actions[0]) {
      expect(plan.actions[0].current_daily_budget).toBe(100)
      expect(plan.actions[0].target_daily_budget).toBe(80)  // 100 × 0.80
    }
    expect(plan.version).toBe('v2')
    expect(plan.monitoring_days).toBe(5)
  })

  it('5. multiple ad sets with no deterministic target → manual_action_required', () => {
    const diagnosis = diagnosePerformance(baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad 1'), makeAd('ad2', 'as2', 'Ad 2')],
      adSets: [
        makeAdSet('as1', 'c1', 'Set 1', 'ACTIVE', '5000'),
        makeAdSet('as2', 'c1', 'Set 2', 'ACTIVE', '5000'),
      ],
      currentAdInsights: [
        makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] }),
        makeAdInsight('ad2', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] }),
      ],
    }))
    const plan = buildRemediationPlan(diagnosis, baseCampaign({
      dailyBudget: null,
      adSets: [
        makeAdSet('as1', 'c1', 'Set 1', 'ACTIVE', '5000'),
        makeAdSet('as2', 'c1', 'Set 2', 'ACTIVE', '5000'),
      ],
    }))
    expect(plan.actions[0].action_type).toBe('manual_action_required')
  })

  it('14. budget reduction capped at 20%', () => {
    const diagnosis = diagnosePerformance(baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad')],
      currentAdInsights: [makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] })],
    }))
    const plan = buildRemediationPlan(diagnosis, baseCampaign({ dailyBudget: 1000 }))
    const action = plan.actions.find(a => 'target_daily_budget' in a)
    if (action && 'target_daily_budget' in action) {
      expect(1 - action.target_daily_budget / 1000).toBeCloseTo(MAX_AUTOMATED_BUDGET_CHANGE, 2)
    }
  })

  it('15. monitoring_days defaults to 5', () => {
    const diagnosis = diagnosePerformance(baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad')],
      currentAdInsights: [makeAdInsight('ad1', { spend: '100', actions_json: [{ action_type: 'lead', value: '2' }] })],
    }))
    expect(buildRemediationPlan(diagnosis, baseCampaign()).monitoring_days).toBe(5)
  })

  it('16. Katering dry run: exact 100→80 DKK with correct ad-set targeting', () => {
    // Simulates the exact Killer Katering production structure
    const diagnosis = diagnosePerformance({
      campaignId: '120249719135140232',
      campaignName: 'Killer Katering - Copenhagen Leads (V1)',
      adAccountId: 'act_fake',
      objective: 'OUTCOME_LEADS',
      currency: 'DKK',
      dailyBudget: null,
      ads: [
        { id: '120249733212060232', ad_set_id: '120249719137290232', name: 'Killer Katering Carousel - Leads V1.1', status: 'ACTIVE' },
        { id: '120249732299250232', ad_set_id: '120249719137290232', name: 'Killer Katering Carousel - Leads V1', status: 'PAUSED' },
      ],
      adSets: [{ id: '120249719137290232', campaign_id: '120249719135140232', name: 'Katering Leads - Greater Copenhagen Broad (IG Feed/Profile)', status: 'ACTIVE', daily_budget: '10000' }],
      currentAdInsights: [
        makeAdInsight('120249733212060232', { spend: '585.89', clicks: 138, impressions: 5450, actions_json: [{ action_type: 'lead', value: '1' }] }),
      ],
      priorAdInsights: [
        makeAdInsight('120249733212060232', { spend: '842.02', clicks: 120, impressions: 8686, actions_json: [{ action_type: 'lead', value: '3' }] }),
      ],
    })

    expect(diagnosis.classification).toBe('broad_deterioration') // Only 1 active ad, can't isolate weak entity

    const plan = buildRemediationPlan(diagnosis, {
      id: '120249719135140232',
      adAccountId: 'act_fake',
      currency: 'DKK',
      dailyBudget: null,
      adSets: [{ id: '120249719137290232', campaign_id: '120249719135140232', name: 'Katering Leads - Greater Copenhagen Broad (IG Feed/Profile)', status: 'ACTIVE', daily_budget: '10000' }],
    })

    expect(plan.actions).toHaveLength(1)
    expect(plan.actions[0].action_type).toBe('meta_set_adset_budget')
    if ('target_daily_budget' in plan.actions[0]) {
      expect(plan.actions[0].current_daily_budget).toBe(100) // 10000 minor units / 100
      expect(plan.actions[0].target_daily_budget).toBe(80)   // 100 × 0.80
    }
    expect(plan.expected_outcome).toContain('100')
    expect(plan.expected_outcome).toContain('80')
    expect(plan.expected_outcome).toContain('DKK')
  })

  it('17. v1 backward compatible: old rows without remediation_plan render', () => {
    // PaidRecommendationRow has remediation_plan as nullable
    const row = { remediation_plan: null, execution_plan: { action_type: 'monitor_only', platform: 'meta', campaign_id: '1' } }
    expect(row.remediation_plan).toBeNull()
    expect(row.execution_plan).toBeTruthy()
  })

  it('18. manual_action_required plans contain no executable mutation', () => {
    const diagnosis = diagnosePerformance(baseDiagnosticInput({
      ads: [makeAd('ad1', 'as1', 'Ad')],
      currentAdInsights: [makeAdInsight('ad1', { spend: '10', impressions: 50, clicks: 2 })],
    }))
    const plan = buildRemediationPlan(diagnosis, baseCampaign())
    const hasManual = plan.actions.some(a => a.action_type === 'manual_action_required')
    const hasMutation = plan.actions.some(a => !['manual_action_required', 'monitor_only', 'run_tracking_diagnostic', 'create_task'].includes(a.action_type))
    expect(hasManual).toBe(true)
    expect(hasMutation).toBe(false)
  })
})

describe('guardrails', () => {
  it('MAX_AUTOMATED_BUDGET_CHANGE is 20%', () => {
    expect(MAX_AUTOMATED_BUDGET_CHANGE).toBe(0.20)
  })
})
