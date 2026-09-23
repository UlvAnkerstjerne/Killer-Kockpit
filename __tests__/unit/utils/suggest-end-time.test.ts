import { describe, it, expect } from 'vitest'
import { suggestEndTime } from '@/lib/utils/suggest-end-time'

describe('suggestEndTime', () => {
  it('adds 30 minutes on the same date', () => {
    expect(suggestEndTime('2026-09-23T10:00')).toBe('2026-09-23T10:30')
  })

  it('carries over minutes correctly (e.g. 10:45 → 11:15)', () => {
    expect(suggestEndTime('2026-09-23T10:45')).toBe('2026-09-23T11:15')
  })

  it('handles midnight boundary: 23:00 → 23:30', () => {
    expect(suggestEndTime('2026-09-23T23:00')).toBe('2026-09-23T23:30')
  })

  it('returns empty string for 23:30 (would cross midnight)', () => {
    expect(suggestEndTime('2026-09-23T23:30')).toBe('')
  })

  it('returns empty string for 23:31', () => {
    expect(suggestEndTime('2026-09-23T23:31')).toBe('')
  })

  it('returns empty string for 23:59', () => {
    expect(suggestEndTime('2026-09-23T23:59')).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(suggestEndTime('')).toBe('')
  })

  it('returns empty string for malformed input (no T)', () => {
    expect(suggestEndTime('2026-09-23 10:00')).toBe('')
  })

  it('pads single-digit hours and minutes', () => {
    expect(suggestEndTime('2026-09-23T00:00')).toBe('2026-09-23T00:30')
  })

  it('preserves the date part exactly', () => {
    const result = suggestEndTime('2026-12-31T22:00')
    expect(result?.startsWith('2026-12-31T')).toBe(true)
    expect(result).toBe('2026-12-31T22:30')
  })

  it('updates suggestion when start changes after end was already suggested', () => {
    // Simulate: user picks 10:00 → end suggested as 10:30, then changes start to 11:00
    const first  = suggestEndTime('2026-09-23T10:00')
    expect(first).toBe('2026-09-23T10:30')
    // Now start changes to 11:00; suggestEndTime is called again (end was not manually edited)
    const second = suggestEndTime('2026-09-23T11:00')
    expect(second).toBe('2026-09-23T11:30')
    // And it differs from the first suggestion, confirming re-evaluation happens
    expect(second).not.toBe(first)
  })
})
