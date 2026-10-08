import { describe, it, expect } from 'vitest'
import {
  balanceLevel, billingHealth, byFeature, byModel, dailySeries, estimateRemaining, summarize, trackingStart,
  startOfCopenhagenDay, type UsageRow,
} from '@/lib/ai/usage-stats'

const NOW = new Date('2026-10-08T10:00:00Z') // 12:00 Copenhagen

const row = (o: Partial<UsageRow> & { created_at: string }): UsageRow => ({
  feature: 'quick_capture', model: 'claude-sonnet-4-6', status: 'success', input_tokens: 100, output_tokens: 50,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0, estimated_cost_usd: 0.01, error_category: null, ...o,
})

describe('windows and daily series', () => {
  const rows = [
    row({ created_at: '2026-10-08T08:00:00Z', estimated_cost_usd: '0.5' }),               // today
    row({ created_at: '2026-10-07T22:30:00Z', estimated_cost_usd: 0.25 }),                // 00:30 on 8 Oct Copenhagen → today
    row({ created_at: '2026-10-07T12:00:00Z', estimated_cost_usd: 1 }),                   // yesterday
    row({ created_at: '2026-09-01T12:00:00Z', estimated_cost_usd: 9 }),                   // outside 30d
  ]

  it('"today" starts at Copenhagen midnight, not UTC midnight', () => {
    expect(startOfCopenhagenDay(NOW).toISOString()).toBe('2026-10-07T22:00:00.000Z')
    expect(summarize(rows, startOfCopenhagenDay(NOW))).toEqual({ cost: 0.75, calls: 2, unpricedCalls: 0 })
  })

  it('daily aggregation is zero-filled and uses Copenhagen days', () => {
    const d = dailySeries(rows, 30, NOW)
    expect(d).toHaveLength(30)
    expect(d.at(-1)).toEqual({ date: '2026-10-08', cost: 0.75, calls: 2 })
    expect(d.at(-2)).toEqual({ date: '2026-10-07', cost: 1, calls: 1 })
    expect(d[0].date).toBe('2026-09-09')
    expect(d.reduce((s, p) => s + p.calls, 0)).toBe(3) // the 1 Sept row falls outside the window
  })
})

describe('feature and model aggregation', () => {
  const rows = [
    row({ created_at: '2026-10-08T01:00:00Z', feature: 'review_reply_draft', estimated_cost_usd: 0.3, input_tokens: 1000, output_tokens: 100 }),
    row({ created_at: '2026-10-08T02:00:00Z', feature: 'review_reply_draft', estimated_cost_usd: 0.2, input_tokens: 500, output_tokens: 50 }),
    row({ created_at: '2026-10-08T03:00:00Z', feature: 'morning_brief', estimated_cost_usd: 0.5 }),
    row({ created_at: '2026-10-08T04:00:00Z', feature: 'quick_capture', status: 'error', estimated_cost_usd: 0, error_category: 'billing_credit_exhausted', input_tokens: 0, output_tokens: 0 }),
    row({ created_at: '2026-10-08T05:00:00Z', feature: 'brain_query', model: 'claude-mystery-1', estimated_cost_usd: null }),
  ]

  it('sorts features by cost, computes share, counts failures and unpriced calls', () => {
    const f = byFeature(rows)
    // review replies and Morning Brief tie on cost ($0.50); more calls ranks first, then name
    expect(f.map(x => x.feature)).toEqual(['review_reply_draft', 'morning_brief', 'brain_query', 'quick_capture'])
    const review = f.find(x => x.feature === 'review_reply_draft')!
    expect(review).toMatchObject({ label: 'Google review replies', calls: 2, inputTokens: 1500, outputTokens: 150, cost: 0.5, share: 0.5 })
    expect(f.find(x => x.feature === 'quick_capture')).toMatchObject({ failures: 1, cost: 0 })
    expect(f.find(x => x.feature === 'brain_query')).toMatchObject({ unpricedCalls: 1 })
    expect(f.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1)
  })

  it('aggregates by model and surfaces unpriced models', () => {
    const m = byModel(rows)
    expect(m[0]).toMatchObject({ model: 'claude-sonnet-4-6', calls: 4, cost: 1 })
    expect(m.find(x => x.model === 'claude-mystery-1')).toMatchObject({ calls: 1, cost: 0, unpricedCalls: 1 })
  })

  it('reports when tracking started', () => {
    expect(trackingStart(rows)).toBe('2026-10-08T01:00:00Z')
    expect(trackingStart([])).toBeNull()
  })
})

describe('credit ledger and estimated remaining', () => {
  it('$100 credit and $2.37 tracked usage → $97.63 remaining', () => {
    const credits = [{ amount_usd: 100, occurred_at: '2026-10-08T00:00:00Z' }]
    const rows = [
      row({ created_at: '2026-10-08T08:00:00Z', estimated_cost_usd: 2 }),
      row({ created_at: '2026-10-08T09:00:00Z', estimated_cost_usd: '0.37' }),
    ]
    const b = estimateRemaining(credits, rows)!
    expect(b.remaining).toBe(97.63)
    expect(b.creditsTotal).toBe(100)
    expect(b.trackedCostSinceFirstCredit).toBe(2.37)
  })

  it('only counts usage from the earliest credit onward and sums multiple credits', () => {
    const credits = [
      { amount_usd: '50', occurred_at: '2026-10-05T00:00:00Z' },
      { amount_usd: 25, occurred_at: '2026-10-07T00:00:00Z' },
    ]
    const rows = [
      row({ created_at: '2026-10-04T12:00:00Z', estimated_cost_usd: 10 }), // before the first credit: excluded
      row({ created_at: '2026-10-06T12:00:00Z', estimated_cost_usd: 5 }),
    ]
    expect(estimateRemaining(credits, rows)!.remaining).toBe(70)
  })

  it('no credit recorded → no estimate', () => {
    expect(estimateRemaining([], [row({ created_at: '2026-10-08T08:00:00Z' })])).toBeNull()
    expect(balanceLevel(null)).toBe('unknown')
  })

  it('alert thresholds: green > $25, amber $10–25, red < $10', () => {
    expect(balanceLevel(97.63)).toBe('green')
    expect(balanceLevel(25.01)).toBe('green')
    expect(balanceLevel(25)).toBe('amber')
    expect(balanceLevel(10)).toBe('amber')
    expect(balanceLevel(9.99)).toBe('red')
    expect(balanceLevel(-3)).toBe('red')
  })
})

describe('billing health', () => {
  const billing = (at: string) => row({ created_at: at, status: 'error', error_category: 'billing_credit_exhausted', estimated_cost_usd: 0 })

  it('blocked when billing rejections are the latest outcome in the last 24h', () => {
    const h = billingHealth([billing('2026-10-08T06:06:00Z'), billing('2026-10-08T06:07:00Z'), row({ created_at: '2026-10-07T20:00:00Z' })], NOW)
    expect(h).toMatchObject({ state: 'blocked', billingFailures24h: 2, lastBillingFailureAt: '2026-10-08T06:07:00Z' })
  })

  it('healthy again once a later request succeeds', () => {
    const h = billingHealth([billing('2026-10-08T06:06:00Z'), row({ created_at: '2026-10-08T07:00:00Z' })], NOW)
    expect(h.state).toBe('healthy')
    expect(h.recoveredAfterBilling).toBe(true)
  })

  it('old billing failures and other errors do not block', () => {
    const h = billingHealth([billing('2026-10-01T06:06:00Z'), row({ created_at: '2026-10-08T07:00:00Z', status: 'error', error_category: 'rate_limit' })], NOW)
    expect(h).toMatchObject({ state: 'healthy', billingFailures24h: 0, otherFailures24h: 1 })
  })
})
