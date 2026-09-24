import { describe, it, expect } from 'vitest'
import { aggregateAdsData, categoryLabel } from '@/lib/actions/marketing/google-ads-utils'

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeDaily(overrides: Partial<{
  campaign_id: string
  date: string
  impressions: number
  clicks: number
  cost: number
  conversions: number
  conversion_results: Array<{
    action_name: string
    category: string
    conversions: string
    all_conversions: string
  }> | null
}> = {}) {
  return {
    campaign_id: overrides.campaign_id ?? 'c1',
    date: overrides.date ?? '2026-09-10',
    impressions: overrides.impressions ?? 100,
    clicks: overrides.clicks ?? 10,
    cost: overrides.cost ?? 50,
    conversions: overrides.conversions ?? 5,
    conversion_results: overrides.conversion_results ?? null,
  }
}

const campaigns = [
  { campaign_id: 'c1', name: 'Campaign A', status: 'ENABLED', channel_type: 'SEARCH' },
  { campaign_id: 'c2', name: 'Campaign B', status: 'PAUSED', channel_type: 'PERFORMANCE_MAX' },
]

const CUR_START = '2026-09-01'
const CUR_END   = '2026-09-14'
const PRI_START = '2026-08-04'
const PRI_END   = '2026-08-17'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('aggregateAdsData', () => {
  it('aggregates spend correctly across campaigns and days', () => {
    const rows = [
      makeDaily({ campaign_id: 'c1', date: '2026-09-10', cost: 100 }),
      makeDaily({ campaign_id: 'c1', date: '2026-09-11', cost: 200 }),
      makeDaily({ campaign_id: 'c2', date: '2026-09-10', cost: 50 }),
    ]
    const { kpis } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(kpis.spend).toBe(350)
  })

  it('aggregates conversions correctly', () => {
    const rows = [
      makeDaily({ date: '2026-09-10', conversions: 10 }),
      makeDaily({ date: '2026-09-11', conversions: 15 }),
    ]
    const { kpis } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(kpis.conversions).toBe(25)
  })

  it('computes cost per result correctly', () => {
    const rows = [
      makeDaily({ date: '2026-09-10', cost: 100, conversions: 20 }),
    ]
    const { kpis } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(kpis.costPerResult).toBe(5) // 100 / 20
  })

  it('returns null cost per result when zero conversions', () => {
    const rows = [
      makeDaily({ date: '2026-09-10', cost: 100, conversions: 0 }),
    ]
    const { kpis } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(kpis.costPerResult).toBeNull()
  })

  it('computes previous-period comparison', () => {
    const rows = [
      makeDaily({ date: '2026-09-10', cost: 100, conversions: 10 }), // current
      makeDaily({ date: '2026-08-10', cost: 200, conversions: 20 }), // prior
    ]
    const { kpis } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(kpis.spend).toBe(100)
    expect(kpis.spendPrior).toBe(200)
    expect(kpis.conversions).toBe(10)
    expect(kpis.convPrior).toBe(20)
  })

  it('does NOT duplicate spend across conversion_results', () => {
    const rows = [
      makeDaily({
        date: '2026-09-10',
        cost: 100,
        conversions: 15,
        conversion_results: [
          { action_name: 'Directions', category: 'GET_DIRECTIONS', conversions: '10', all_conversions: '10' },
          { action_name: 'Calls', category: 'CONTACT', conversions: '5', all_conversions: '5' },
        ],
      }),
    ]
    const { kpis, campaigns: campRows } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    // Spend should be 100 total, not 200 (duplicated per conversion type)
    expect(kpis.spend).toBe(100)
    expect(campRows[0].spend).toBe(100)
  })

  it('aggregates conversion_results breakdown per campaign', () => {
    const rows = [
      makeDaily({
        date: '2026-09-10',
        conversions: 15,
        conversion_results: [
          { action_name: 'Directions', category: 'GET_DIRECTIONS', conversions: '10', all_conversions: '10' },
          { action_name: 'Calls', category: 'CONTACT', conversions: '5', all_conversions: '5' },
        ],
      }),
      makeDaily({
        date: '2026-09-11',
        conversions: 8,
        conversion_results: [
          { action_name: 'Directions', category: 'GET_DIRECTIONS', conversions: '8', all_conversions: '8' },
        ],
      }),
    ]
    const { campaigns: campRows } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(campRows[0].breakdown).toHaveLength(2)
    expect(campRows[0].breakdown[0].actionName).toBe('Directions')
    expect(campRows[0].breakdown[0].conversions).toBe(18)
    expect(campRows[0].breakdown[1].actionName).toBe('Calls')
    expect(campRows[0].breakdown[1].conversions).toBe(5)
  })

  it('handles inactive campaign with current-period activity', () => {
    const rows = [
      makeDaily({ campaign_id: 'c2', date: '2026-09-10', cost: 50, conversions: 3 }),
    ]
    const { campaigns: campRows } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(campRows).toHaveLength(1)
    expect(campRows[0].name).toBe('Campaign B')
    expect(campRows[0].status).toBe('PAUSED')
    expect(campRows[0].spend).toBe(50)
  })

  it('result labels come from Google metadata category, not campaign name', () => {
    const rows = [
      makeDaily({
        date: '2026-09-10',
        conversions: 10,
        conversion_results: [
          { action_name: 'Lokale handlinger – rutevejledning', category: 'GET_DIRECTIONS', conversions: '10', all_conversions: '10' },
        ],
      }),
    ]
    const { kpis, campaigns: campRows } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(kpis.resultLabel).toBe('Directions')
    expect(campRows[0].resultLabel).toBe('Directions')
  })

  it('uses generic "Conversions" label when no single category dominates', () => {
    const rows = [
      makeDaily({
        date: '2026-09-10',
        conversions: 10,
        conversion_results: [
          { action_name: 'Directions', category: 'GET_DIRECTIONS', conversions: '4', all_conversions: '4' },
          { action_name: 'Calls', category: 'CONTACT', conversions: '3', all_conversions: '3' },
          { action_name: 'Purchases', category: 'PURCHASE', conversions: '3', all_conversions: '3' },
        ],
      }),
    ]
    const { kpis } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(kpis.resultLabel).toBe('Conversions')
  })

  it('produces correct daily trend rows', () => {
    const rows = [
      makeDaily({ campaign_id: 'c1', date: '2026-09-10', cost: 50, conversions: 5 }),
      makeDaily({ campaign_id: 'c2', date: '2026-09-10', cost: 30, conversions: 3 }),
      makeDaily({ campaign_id: 'c1', date: '2026-09-11', cost: 40, conversions: 4 }),
    ]
    const { daily } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(daily).toHaveLength(2)
    expect(daily[0]).toEqual({ date: '2026-09-10', spend: 80, conversions: 8 })
    expect(daily[1]).toEqual({ date: '2026-09-11', spend: 40, conversions: 4 })
  })

  it('filters out zero-conversion breakdown rows', () => {
    const rows = [
      makeDaily({
        date: '2026-09-10',
        conversions: 5,
        conversion_results: [
          { action_name: 'Directions', category: 'GET_DIRECTIONS', conversions: '5', all_conversions: '5' },
          { action_name: 'Dead action', category: 'PAGE_VIEW', conversions: '0', all_conversions: '0' },
        ],
      }),
    ]
    const { campaigns: campRows } = aggregateAdsData(rows, campaigns, CUR_START, CUR_END, PRI_START, PRI_END)
    expect(campRows[0].breakdown).toHaveLength(1)
    expect(campRows[0].breakdown[0].actionName).toBe('Directions')
  })
})

describe('categoryLabel', () => {
  it('maps known categories', () => {
    expect(categoryLabel('GET_DIRECTIONS')).toBe('Directions')
    expect(categoryLabel('PHONE_CALL_LEAD')).toBe('Calls')
    expect(categoryLabel('PURCHASE')).toBe('Purchases')
  })

  it('returns raw category for unknown values', () => {
    expect(categoryLabel('SOME_NEW_TYPE')).toBe('SOME_NEW_TYPE')
  })
})
