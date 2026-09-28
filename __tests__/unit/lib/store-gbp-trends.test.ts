import { describe, it, expect } from 'vitest'
import { computeRatingTrend, formatWeekComparison } from '@/lib/store/adapter'

// ─── computeRatingTrend ──────────────────────────────────────────────────────

describe('computeRatingTrend', () => {
  it('returns "up" when recent average is >= 0.05 above previous', () => {
    expect(computeRatingTrend(4.60, 4.50)).toBe('up')
    expect(computeRatingTrend(4.55, 4.50)).toBe('up')
    expect(computeRatingTrend(5.0, 4.0)).toBe('up')
  })

  it('returns "down" when recent average is >= 0.05 below previous', () => {
    expect(computeRatingTrend(4.45, 4.50)).toBe('down')
    expect(computeRatingTrend(4.0, 4.50)).toBe('down')
  })

  it('returns "flat" when difference is within ±0.05 dead zone', () => {
    expect(computeRatingTrend(4.50, 4.50)).toBe('flat')
    expect(computeRatingTrend(4.52, 4.50)).toBe('flat')
    expect(computeRatingTrend(4.48, 4.50)).toBe('flat')
    // 0.049 diff rounds to 0.05 → exactly at boundary → up
    expect(computeRatingTrend(4.549, 4.50)).toBe('up')
    // 0.04 diff stays flat
    expect(computeRatingTrend(4.54, 4.50)).toBe('flat')
  })

  it('returns null when recent average is missing', () => {
    expect(computeRatingTrend(null, 4.50)).toBeNull()
  })

  it('returns null when previous average is missing', () => {
    expect(computeRatingTrend(4.50, null)).toBeNull()
  })

  it('returns null when both averages are missing', () => {
    expect(computeRatingTrend(null, null)).toBeNull()
  })
})

// ─── formatWeekComparison ────────────────────────────────────────────────────

describe('formatWeekComparison', () => {
  it('shows increase percentage', () => {
    expect(formatWeekComparison(8, 6)).toBe('↑ 33% vs last week')
  })

  it('shows decrease percentage', () => {
    expect(formatWeekComparison(4, 5)).toBe('↓ 20% vs last week')
  })

  it('shows same when counts are equal', () => {
    expect(formatWeekComparison(5, 5)).toBe('→ Same as last week')
  })

  it('handles previous week zero with current positive', () => {
    expect(formatWeekComparison(3, 0)).toBe('↑ +3 vs last week')
  })

  it('handles both weeks zero', () => {
    expect(formatWeekComparison(0, 0)).toBe('→ Same as last week')
  })

  it('returns empty string when previous is null', () => {
    expect(formatWeekComparison(5, null)).toBe('')
  })

  it('rounds percentage to nearest integer', () => {
    // 3/7 = 42.857...% → 43%
    expect(formatWeekComparison(10, 7)).toBe('↑ 43% vs last week')
  })

  it('shows 100% for doubling', () => {
    expect(formatWeekComparison(10, 5)).toBe('↑ 100% vs last week')
  })

  it('shows 50% decrease', () => {
    expect(formatWeekComparison(5, 10)).toBe('↓ 50% vs last week')
  })
})
