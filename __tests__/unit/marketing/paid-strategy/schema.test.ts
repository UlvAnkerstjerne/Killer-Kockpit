import { describe, expect, it, vi } from 'vitest'
import { rec } from '../../../helpers/paid-strategy'
import { FIELD_MAX_CHARS, FIELD_TARGET_CHARS, PaidStrategyOutputSchema, PaidStrategyRecommendationSchema, RECOMMENDATION_TYPES } from '@/lib/marketing/paid-strategy/types'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/usage', () => ({ trackAiCallWithRetries: (_m: unknown, call: () => unknown) => call(), SDK_DEFAULT_MAX_RETRIES: 2 }))
import { PaidStrategyValidationError, validatePaidStrategy } from '@/lib/ai/paid-strategy'

describe('Paid Strategy output schema', () => {
  it('accepts every required field and all eight recommendation types', () => {
    for (const type of RECOMMENDATION_TYPES) expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { recommendation_type: type })).success).toBe(true)
    expect(RECOMMENDATION_TYPES).toEqual(['campaign_structure', 'retargeting', 'audience', 'creative', 'copy', 'budget', 'tracking', 'funnel'])
  })
  it('allows at most three recommendations and zero', () => {
    expect(PaidStrategyOutputSchema.safeParse({ recommendations: [] }).success).toBe(true)
    expect(PaidStrategyOutputSchema.safeParse({ recommendations: [rec(1), rec(2), rec(3)] }).success).toBe(true)
    expect(PaidStrategyOutputSchema.safeParse({ recommendations: [rec(1), rec(2), rec(3), rec(4)] }).success).toBe(false)
  })
  it('rejects an unknown type and any missing field', () => {
    expect(PaidStrategyRecommendationSchema.safeParse({ ...rec(), recommendation_type: 'scale_winner' }).success).toBe(false)
    for (const key of Object.keys(rec())) {
      const partial: Record<string, unknown> = { ...rec() }
      delete partial[key]
      expect(PaidStrategyRecommendationSchema.safeParse(partial).success, key).toBe(false)
    }
  })
  it('is advisory by construction: no campaign_id, payload or execution field can be added', () => {
    for (const extra of ['campaign_id', 'action_intent', 'execution_plan', 'payload', 'target_id']) {
      expect(PaidStrategyRecommendationSchema.safeParse({ ...rec(), [extra]: '1' }).success, extra).toBe(false)
    }
    expect(PaidStrategyOutputSchema.safeParse({ recommendations: [], extra: true }).success).toBe(false)
  })
})

describe('Paid Strategy field lengths', () => {
  const padded = (base: string, n: number) => (base + ' lorem ipsum dolor sit amet'.repeat(80)).slice(0, n)
  it('keeps hard maxima above the targets the model is told about', () => {
    for (const key of Object.keys(FIELD_TARGET_CHARS) as (keyof typeof FIELD_TARGET_CHARS)[]) expect(FIELD_MAX_CHARS[key], key).toBeGreaterThan(FIELD_TARGET_CHARS[key])
  })
  it('accepts the modest overshoot seen in the first live run instead of discarding the analysis', () => {
    // First live run (2026-10-08): interpretation 623/514/587, exact_test_or_action 727, evidence 612, limitations 587 against old caps of 500/700/600/500.
    const live = rec(1, {
      interpretation: padded('Interpretation. ', 623), exact_test_or_action: padded('Set up a test. ', 727),
      evidence: padded('Evidence. ', 612), evidence_limitations: padded('Limitations. ', 587),
    })
    expect(PaidStrategyRecommendationSchema.safeParse(live).success).toBe(true)
    expect(validatePaidStrategy({ recommendations: [live] })).toHaveLength(1)
  })
  it('still rejects runaway output', () => {
    for (const key of Object.keys(FIELD_MAX_CHARS) as (keyof typeof FIELD_MAX_CHARS)[]) {
      expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { [key]: padded('x ', FIELD_MAX_CHARS[key] + 1) })).success, key).toBe(false)
    }
  })
  it('fits three maximal recommendations inside the database size bound', () => {
    const max = Object.values(FIELD_MAX_CHARS).reduce((a, b) => a + b, 0) + 40
    expect(max * 3).toBeLessThan(30_000)
  })
})

describe('Paid Strategy output validation', () => {
  it('passes normal evidence-style text with numbers and currency', () => {
    expect(validatePaidStrategy({ recommendations: [rec(1)] })).toHaveLength(1)
  })
  it.each([
    ['URL', { evidence: 'See https://facebook.com/ads/manager for the detail of the spend.' }],
    ['ad account id', { exact_test_or_action: 'Duplicate the setup inside act_123456789 and run for 14 days.' }],
    ['long numeric platform id', { evidence: 'Campaign 120000000000001 spent DKK 2,800 in the window.' }],
    ['credential wording', { exact_test_or_action: 'Use the access token to create the audience test.' }],
    ['payload shape', { exact_test_or_action: 'POST {"campaign_id": "12", "daily_budget": 50} to create the test.' }],
    ['kill decision', { exact_test_or_action: 'Kill the weakest ad set and move the budget to leads.' }],
    ['pause decision', { title: 'Pause the campaign and rebuild the funnel' }],
    ['scale decision', { exact_test_or_action: 'Scale up the lead campaign by DKK 50 per day for two weeks.' }],
  ])('rejects %s', (_name, override) => {
    expect(() => validatePaidStrategy({ recommendations: [rec(1, override)] })).toThrow(PaidStrategyValidationError)
  })
  it('rejects duplicate titles', () => {
    expect(() => validatePaidStrategy({ recommendations: [rec(1, { title: 'Same title here' }), rec(2, { title: 'same title here' })] })).toThrow('Duplicate')
  })
  it('rejects schema violations before content checks', () => {
    expect(() => validatePaidStrategy({ recommendations: [{ ...rec(), campaign_id: '12' }] })).toThrow()
  })
})

describe('Paid Strategy shared budget headroom', () => {
  const withHeadroom = (headroom: number | null) => ({ budget: { projection: { projected_incremental_headroom: headroom } } }) as never
  const recs = (...amounts: number[]) => ({ recommendations: amounts.map((a, i) => rec(i + 1, { title: `Distinct idea number ${i + 1}`, incremental_budget_dkk: a })) })

  it('requires incremental_budget_dkk on every recommendation and rejects negatives', () => {
    const without: Record<string, unknown> = { ...rec() }
    delete without.incremental_budget_dkk
    expect(PaidStrategyRecommendationSchema.safeParse(without).success).toBe(false)
    expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { incremental_budget_dkk: -1 })).success).toBe(false)
    expect(PaidStrategyRecommendationSchema.safeParse(rec(1, { incremental_budget_dkk: 0 })).success).toBe(true)
  })
  it('accepts combined budgets that fit, including exactly at the limit', () => {
    expect(validatePaidStrategy(recs(900, 900, 900), withHeadroom(2721))).toHaveLength(3)
    expect(validatePaidStrategy(recs(1000, 1000, 721), withHeadroom(2721))).toHaveLength(3)
  })
  it('rejects budgets that each fit alone but not together (the first live run: 2,000 + 1,500 + 1,500 vs ~2.7k)', () => {
    expect(() => validatePaidStrategy(recs(2000, 1500, 1500), withHeadroom(2721))).toThrow('exceed projected headroom')
    expect(() => validatePaidStrategy(recs(1500, 1500, 0), withHeadroom(2721))).toThrow(PaidStrategyValidationError)
  })
  it('rejects any test budget when headroom is not reliable, and accepts zero-spend recommendations', () => {
    expect(() => validatePaidStrategy(recs(1, 0, 0), withHeadroom(null))).toThrow('not reliable')
    expect(validatePaidStrategy(recs(0, 0, 0), withHeadroom(null))).toHaveLength(3)
    expect(() => validatePaidStrategy(recs(1), withHeadroom(0))).toThrow('exceed projected headroom')
  })
  it('skips the budget check only when no evidence is supplied (content-only unit tests)', () => {
    expect(validatePaidStrategy(recs(999999))).toHaveLength(1)
  })
})

describe('Paid Strategy vanity-metric guard', () => {
  const metric = (success_metric: string) => ({ recommendations: [rec(1, { success_metric })] })
  it.each([
    'Cost per link click below 20.50 DKK with at least 100 link clicks.',
    "Cost_per_link_click below C5's prior 20.50 DKK over 14 days, with at least 100 link_clicks recorded.",
    'CPM for the retargeting campaign lower than 91.09 DKK.',
    'More profile visits and video views than the prior 28 days.',
    'Higher CTR and more landing page views than the current ad.',
  ])('rejects a success metric made only of vanity measures: %s', text => {
    expect(() => validatePaidStrategy(metric(text))).toThrow('vanity metric')
  })
  it.each([
    'At least 5 voucher redemptions attributed to the ad within 14 days.',
    'Cost per lead at or below the prior 28 days; link clicks are tracked only as a diagnostic.',
    'The app first-order event fires correctly for 20 test orders before any spend is added.',
    'Catering leads that become closed orders, counted weekly against the same period.',
    'Offer-code redemptions at the destination, not clicks to it.',
  ])('accepts a business outcome or its measurement: %s', text => {
    expect(validatePaidStrategy(metric(text))).toHaveLength(1)
  })
})
