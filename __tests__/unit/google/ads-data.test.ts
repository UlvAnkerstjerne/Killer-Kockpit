import { describe, expect, it } from 'vitest'
import { adsDateRange, buildAdsDailyRows } from '@/lib/google/ads-data'

const range = { start: '2026-09-03', end: '2026-09-16' }
const stamp = '2026-09-17T06:00:00Z'
describe('Google Ads daily reporting', () => {
  it('uses exactly 90 or 14 completed account-local days, including across DST', () => {
    expect(adsDateRange(new Date(stamp), 'Europe/Copenhagen', true)).toEqual({ start: '2026-06-19', end: '2026-09-16' })
    expect(adsDateRange(new Date(stamp), 'Europe/Copenhagen', false)).toEqual(range)
    expect(adsDateRange(new Date('2026-03-29T23:30:00Z'), 'Europe/Copenhagen', false)).toEqual({ start: '2026-03-16', end: '2026-03-29' })
    expect(adsDateRange(new Date('2026-09-17T00:30:00Z'), 'America/Los_Angeles', false)).toEqual({ start: '2026-09-02', end: '2026-09-15' })
  })
  it('preserves exact micros, fractional conversions and separate primary/all results without duplicating spend', () => {
    const rows = buildAdsDailyRows('8582465933', [{ campaign: { id: '1' }, segments: { date: range.end },
      metrics: { impressions: '9007199254740993', clicks: '5', costMicros: '84000123', conversions: '1.25', allConversions: '5.75' } }],
    [{ campaign: { id: '1' }, segments: { date: range.end, conversionAction: 'customers/8582465933/conversionActions/2', conversionActionName: 'Lead form', conversionActionCategory: 'SUBMIT_LEAD_FORM' }, metrics: { conversions: 1.25, allConversions: 1.75 } },
      { campaign: { id: '1' }, segments: { date: range.end, conversionAction: 'customers/8582465933/conversionActions/3', conversionActionName: 'Directions', conversionActionCategory: 'GET_DIRECTIONS' }, metrics: { allConversions: 4 } }], [], range, stamp)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ impressions: '9007199254740993', cost_micros: '84000123', conversions: '1.25', all_conversions: '5.75' })
    expect(rows[0].conversion_results).toHaveLength(2)
    expect(rows[0].conversion_results[1]).toMatchObject({ category: 'GET_DIRECTIONS', conversions: '0', all_conversions: '4' })
    expect(rows[0].conversion_results[0]).not.toHaveProperty('cost_micros')
  })
  it('clears previously stored days omitted by a refreshed zero-metrics report', () => {
    const rows = buildAdsDailyRows('8582465933', [], [], [{ campaign_id: '1', date: range.end }], range, stamp)
    expect(rows[0]).toMatchObject({ conversions: '0', cost_micros: '0', conversion_results: [] })
    expect(buildAdsDailyRows('8582465933', [], [], [], range, stamp)).toEqual([])
  })
  it('rejects invalid dates and duplicate totals instead of double-counting', () => {
    const row = { campaign: { id: '1' }, segments: { date: range.end } }
    expect(() => buildAdsDailyRows('8582465933', [row, row], [], [], range, stamp)).toThrow('Duplicate')
    expect(() => buildAdsDailyRows('8582465933', [{ ...row, segments: { date: '2026-01-01' } }], [], [], range, stamp)).toThrow('invalid')
  })
})
