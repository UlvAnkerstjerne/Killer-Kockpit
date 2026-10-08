import { describe, expect, it, vi } from 'vitest'
import { rec } from '../../../helpers/paid-strategy'
import { PaidStrategyOutputSchema, PaidStrategyRecommendationSchema, RECOMMENDATION_TYPES } from '@/lib/marketing/paid-strategy/types'

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
