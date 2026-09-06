import { describe, it, expect } from 'vitest'
import { formatUpdateDate } from '@/lib/utils/format-update-date'

/**
 * Tests for formatUpdateDate — the pure display function for Universal Update dates.
 *
 * This function is the canonical source of truth for the date display rule:
 *   occurred_on present → show that date (the event happened then)
 *   occurred_on null    → prefix "Added" + created_at date (honest: this is when we
 *                          recorded it, not necessarily when it happened)
 *
 * The tests run in Node (no DOM) — the function is pure and environment-independent.
 */

describe('formatUpdateDate', () => {

  // ── occurred_on present ───────────────────────────────────────────────────

  it('formats occurred_on as day + short month (no "Added" prefix)', () => {
    const result = formatUpdateDate('2026-09-07', '2026-09-09T10:00:00Z')
    // Should not say "Added"
    expect(result).not.toMatch(/added/i)
    // Should contain the day and month from occurred_on (7 Sep)
    expect(result).toMatch(/7/)
    expect(result).toMatch(/Sep/i)
  })

  it('uses occurred_on date, not the created_at date', () => {
    // occurred_on = 7 Sept, created_at = 9 Sept — must show 7
    const result = formatUpdateDate('2026-09-07', '2026-09-09T10:00:00Z')
    // Day 7 should appear, not day 9
    expect(result).toMatch(/\b7\b/)
  })

  it('parses occurred_on as local calendar date (avoids UTC midnight shift)', () => {
    // '2026-09-01' should display as "1 Sep" even in UTC- timezones
    // We parse explicitly as local: new Date(2026, 8, 1)
    const result = formatUpdateDate('2026-09-01', '2026-09-05T00:00:00Z')
    expect(result).toMatch(/\b1\b/)
    expect(result).toMatch(/Sep/i)
  })

  it('formats occurred_on for January correctly', () => {
    const result = formatUpdateDate('2026-01-15', '2026-01-20T08:00:00Z')
    expect(result).toMatch(/15/)
    expect(result).toMatch(/Jan/i)
  })

  it('formats occurred_on for December correctly', () => {
    const result = formatUpdateDate('2026-12-25', '2026-12-26T12:00:00Z')
    expect(result).toMatch(/25/)
    expect(result).toMatch(/Dec/i)
  })

  it('formats occurred_on at start of year', () => {
    const result = formatUpdateDate('2026-01-01', '2026-01-02T00:00:00Z')
    expect(result).toMatch(/\b1\b/)
    expect(result).toMatch(/Jan/i)
    expect(result).not.toMatch(/Added/i)
  })

  // ── occurred_on null → "Added" prefix ────────────────────────────────────

  it('prefixes "Added" when occurred_on is null', () => {
    const result = formatUpdateDate(null, '2026-09-09T10:00:00Z')
    expect(result).toMatch(/^Added /i)
  })

  it('shows created_at date when occurred_on is null', () => {
    // created_at = 9 September
    const result = formatUpdateDate(null, '2026-09-09T10:00:00Z')
    expect(result).toMatch(/9/)
    expect(result).toMatch(/Sep/i)
  })

  it('does not show occurred_on date when null — uses created_at date', () => {
    // If occurred_on were '2026-09-01' we'd see "1 Sep"; with null we see "Added 9 Sep"
    const result = formatUpdateDate(null, '2026-09-09T10:00:00Z')
    // Should contain 9, not just 1
    expect(result).toMatch(/9/)
  })

  it('prefixes "Added" for January created_at', () => {
    const result = formatUpdateDate(null, '2026-01-03T08:00:00Z')
    expect(result).toMatch(/^Added /i)
    expect(result).toMatch(/3/)
    expect(result).toMatch(/Jan/i)
  })

  // ── Honesty: the two sources must produce different output ────────────────

  it('occurred_on and created_at display differently when dates differ', () => {
    const withOccurred = formatUpdateDate('2026-08-01', '2026-09-09T10:00:00Z')
    const withNull     = formatUpdateDate(null,          '2026-09-09T10:00:00Z')
    // They must not be equal — one is an event date, one is a creation timestamp with prefix
    expect(withOccurred).not.toEqual(withNull)
  })

  it('output for occurred_on does not start with "Added"', () => {
    const result = formatUpdateDate('2026-06-15', '2026-07-01T00:00:00Z')
    expect(result).not.toMatch(/^Added/)
  })

  it('output for null occurred_on always starts with "Added"', () => {
    const result = formatUpdateDate(null, '2026-06-15T00:00:00Z')
    expect(result.startsWith('Added ')).toBe(true)
  })
})
