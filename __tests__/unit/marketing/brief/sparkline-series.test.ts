/**
 * Unit tests for buildDailySeries from lib/marketing/brief/collect-data.ts
 *
 * Pure function tests — no DB, no AI, no mocks required.
 */

import { describe, it, expect } from 'vitest'
import { buildDailySeries } from '@/lib/marketing/brief/collect-data'

describe('buildDailySeries', () => {
  it('returns empty array for empty input', () => {
    expect(buildDailySeries([])).toEqual([])
  })

  it('returns empty array when all values are null', () => {
    const rows = [
      { date: '2026-08-26', value: null },
      { date: '2026-08-27', value: null },
    ]
    expect(buildDailySeries(rows)).toEqual([])
  })

  it('returns empty array when all values are undefined', () => {
    const rows = [
      { date: '2026-08-26', value: undefined },
    ]
    expect(buildDailySeries(rows)).toEqual([])
  })

  it('returns points in chronological order', () => {
    const rows = [
      { date: '2026-08-28', value: 30 },
      { date: '2026-08-26', value: 10 },
      { date: '2026-08-27', value: 20 },
    ]
    const result = buildDailySeries(rows)
    expect(result.map((p) => p.date)).toEqual(['2026-08-26', '2026-08-27', '2026-08-28'])
    expect(result.map((p) => p.value)).toEqual([10, 20, 30])
  })

  it('sums multiple rows with the same date (multi-campaign aggregation)', () => {
    const rows = [
      { date: '2026-08-26', value: 100 },
      { date: '2026-08-26', value: 250 },
      { date: '2026-08-27', value: 50 },
    ]
    const result = buildDailySeries(rows)
    expect(result).toEqual([
      { date: '2026-08-26', value: 350 },
      { date: '2026-08-27', value: 50 },
    ])
  })

  it('includes zero as a valid value (not treated as null)', () => {
    const rows = [
      { date: '2026-08-26', value: 100 },
      { date: '2026-08-27', value: 0 },
      { date: '2026-08-28', value: 50 },
    ]
    const result = buildDailySeries(rows)
    expect(result.find((p) => p.date === '2026-08-27')?.value).toBe(0)
    expect(result).toHaveLength(3)
  })

  it('skips null values but keeps other dates', () => {
    const rows = [
      { date: '2026-08-26', value: 100 },
      { date: '2026-08-27', value: null },
      { date: '2026-08-28', value: 80 },
    ]
    const result = buildDailySeries(rows)
    expect(result.map((p) => p.date)).toEqual(['2026-08-26', '2026-08-28'])
  })

  it('handles sparse data (fewer than 7 days)', () => {
    const rows = [
      { date: '2026-08-24', value: 42 },
      { date: '2026-08-26', value: 57 },
    ]
    const result = buildDailySeries(rows)
    expect(result).toEqual([
      { date: '2026-08-24', value: 42 },
      { date: '2026-08-26', value: 57 },
    ])
  })

  it('returns a single point for a single valid row', () => {
    const result = buildDailySeries([{ date: '2026-08-26', value: 99 }])
    expect(result).toEqual([{ date: '2026-08-26', value: 99 }])
  })

  it('returns a full 7-day spend series summed across two campaigns', () => {
    const rows = [
      // Campaign A
      { date: '2026-08-25', value: 120 },
      { date: '2026-08-26', value: 130 },
      { date: '2026-08-27', value: 110 },
      { date: '2026-08-28', value: 140 },
      { date: '2026-08-29', value: 150 },
      { date: '2026-08-30', value: 135 },
      { date: '2026-08-31', value: 125 },
      // Campaign B
      { date: '2026-08-25', value: 80 },
      { date: '2026-08-26', value: 70 },
      { date: '2026-08-27', value: 90 },
      { date: '2026-08-28', value: 60 },
      { date: '2026-08-29', value: 50 },
      { date: '2026-08-30', value: 65 },
      { date: '2026-08-31', value: 75 },
    ]
    const result = buildDailySeries(rows)
    expect(result).toHaveLength(7)
    expect(result[0]).toEqual({ date: '2026-08-25', value: 200 })
    expect(result[6]).toEqual({ date: '2026-08-31', value: 200 })
    expect(result.map((p) => p.date)).toEqual([
      '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28',
      '2026-08-29', '2026-08-30', '2026-08-31',
    ])
  })

  it('returns a 7-day IG reach series', () => {
    const rows = [
      { date: '2026-08-25', value: 500 },
      { date: '2026-08-26', value: 620 },
      { date: '2026-08-27', value: 580 },
      { date: '2026-08-28', value: 710 },
      { date: '2026-08-29', value: 690 },
      { date: '2026-08-30', value: 730 },
      { date: '2026-08-31', value: 660 },
    ]
    const result = buildDailySeries(rows)
    expect(result).toHaveLength(7)
    expect(result[0].value).toBe(500)
    expect(result[6].value).toBe(660)
  })

  it('returns a 7-day FB views series', () => {
    const rows = [
      { date: '2026-08-25', value: 200 },
      { date: '2026-08-26', value: 220 },
      { date: '2026-08-27', value: 190 },
      { date: '2026-08-28', value: 240 },
      { date: '2026-08-29', value: 210 },
      { date: '2026-08-30', value: 230 },
      { date: '2026-08-31', value: 205 },
    ]
    const result = buildDailySeries(rows)
    expect(result).toHaveLength(7)
    expect(result.map((p) => p.date)).toEqual([
      '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28',
      '2026-08-29', '2026-08-30', '2026-08-31',
    ])
  })
})
