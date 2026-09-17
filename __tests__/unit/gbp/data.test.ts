import { describe, it, expect } from 'vitest'
import { dailyPerformanceRows, gbpDateRange, gbpKeywordMonths, keywordRows, profileSnapshot, mappingIssues, dateChunks } from '@/lib/gbp/data'
const range = { start: '2026-09-01', end: '2026-09-02' }
const series = [{ dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 } }] } }]
describe('GBP data normalization', () => {
  it('distinguishes explicit proto zero, missing point and missing metric', () => {
    const rows = dailyPerformanceRows('gbp-1', series, range, 'now')
    expect(rows[0].metric_values.WEBSITE_CLICKS).toBe('0')
    expect(rows[1].metric_values.WEBSITE_CLICKS).toBeNull()
    expect(rows[0].metric_values.CALL_CLICKS).toBeNull()
    expect(rows[0].total_impressions).toBeNull()
  })
  it('preserves int64 values without rounding', () => {
    const rows = dailyPerformanceRows('1', [{ ...series[0], timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: '9007199254740993' }] } }], range, 'now')
    expect(rows[0].metric_values.WEBSITE_CLICKS).toBe('9007199254740993')
  })
  it('does not combine sub-entity series into a fabricated total', () => {
    const rows = dailyPerformanceRows('1', [{ ...series[0], dailySubEntityType: { dayOfWeek: 'MONDAY' } }], range, 'now')
    expect(rows[0].metric_values.WEBSITE_CLICKS).toBeNull()
    expect(rows[0].metric_breakdowns).toHaveLength(1)
  })
  it('rejects empty, malformed, negative and out-of-range data', () => {
    expect(() => dailyPerformanceRows('1', [], range, '')).toThrow()
    for (const value of ['-1', 'bad', '1.5']) expect(() => dailyPerformanceRows('1', [{ ...series[0], timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value }] } }], range, '')).toThrow()
    expect(() => dailyPerformanceRows('1', series, { start: '2026-09-02', end: '2026-09-02' }, '')).toThrow()
  })
  it('preserves keyword thresholds separately from exact counts and missing values', () => {
    expect(keywordRows([{ searchKeyword: 'kebab', insightsValue: { value: '123' } }, { searchKeyword: 'restaurant', insightsValue: { threshold: '15' } }, { searchKeyword: 'unknown' }])).toEqual([
      { keyword: 'kebab', impressions: '123', impressions_threshold: null },
      { keyword: 'restaurant', impressions: null, impressions_threshold: '15' },
      { keyword: 'unknown', impressions: null, impressions_threshold: null },
    ])
    expect(() => keywordRows([{ searchKeyword: 'x', insightsValue: { value: '1', threshold: '15' } }])).toThrow()
  })
  it('keeps profile fields external and leaves omitted fields unknown', () => {
    const row = profileSnapshot({ name: 'locations/123', title: 'Google title', openInfo: { status: 'OPEN' }, regularHours: { periods: [] } }, 'now')
    expect(row.profile_title).toBe('Google title'); expect(row.website_uri).toBeNull()
    expect(row).not.toHaveProperty('location_id'); expect(row).not.toHaveProperty('store_name'); expect(row).not.toHaveProperty('active')
  })
  it('uses Copenhagen completed days around DST and year/month boundaries', () => {
    expect(gbpDateRange(new Date('2026-03-29T22:30:00Z'), false)).toEqual({ start: '2026-03-16', end: '2026-03-29' })
    const months = gbpKeywordMonths(new Date('2026-01-01T12:00:00Z'), true)
    expect(months).toHaveLength(18); expect(months[0]).toBe('2024-07-01'); expect(months.at(-1)).toBe('2025-12-01')
    expect(dateChunks({ start: '2026-01-01', end: '2026-02-02' })).toEqual([{ start: '2026-01-01', end: '2026-01-31' }, { start: '2026-02-01', end: '2026-02-02' }])
  })
  it('flags duplicate Google IDs and ambiguous canonical links, never fuzzy-maps titles', () => {
    const base = { google_account_id: '1', google_location_id: '2', location_id: 'canonical', store_name: 'A', store_short_name: 'A', activation_date: '', active: true }
    expect([...mappingIssues([{ ...base, id: 'a' }, { ...base, id: 'b', google_location_id: '3' }])]).toEqual(['a', 'b'])
    expect(mappingIssues([{ ...base, id: 'a', location_id: null }, { ...base, id: 'b', google_location_id: '3', location_id: null }]).size).toBe(0)
  })
})
