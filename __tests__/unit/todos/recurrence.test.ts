/**
 * Unit tests for lib/todos/recurrence.ts
 *
 * Test matrix (28 cases):
 *   [1-4]   formatRecurrenceBadge — display labels
 *   [5-10]  computeFirstOccurrence — daily/weekly/weekdays (incl. weekend boundary)
 *   [11-16] computeFirstOccurrence — specific weekday (today match + future)
 *   [17-22] computeFirstOccurrence — monthly (same day, past day, end-of-month clamping)
 *   [23-28] computeFirstOccurrence — timezone boundary (CPH midnight vs UTC)
 *
 * Reference calendar for Sep 2026:
 *   Thu 3, Fri 4, Sat 5, Sun 6, Mon 7, Tue 8, Wed 9, Thu 10, Fri 11, Sat 12, Sun 13, Mon 14
 */

import { describe, it, expect } from 'vitest'
import { formatRecurrenceBadge, computeFirstOccurrence } from '@/lib/todos/recurrence'

// ---------------------------------------------------------------------------
// formatRecurrenceBadge
// ---------------------------------------------------------------------------

describe('formatRecurrenceBadge', () => {
  it('[1] daily', () => {
    expect(formatRecurrenceBadge('daily')).toBe('Daily')
  })

  it('[2] weekdays', () => {
    expect(formatRecurrenceBadge('weekdays')).toBe('Every weekday')
  })

  it('[3] specific weekday', () => {
    expect(formatRecurrenceBadge('mon')).toBe('Every Monday')
    expect(formatRecurrenceBadge('fri')).toBe('Every Friday')
  })

  it('[4a] monthly first day (day=1) shows "first day" label', () => {
    expect(formatRecurrenceBadge('monthly', 1)).toBe('Monthly · first day')
  })

  it('[4b] monthly last day (day=31) shows "last day" label', () => {
    expect(formatRecurrenceBadge('monthly', 31)).toBe('Monthly · last day')
  })

  it('[4c] monthly with other day uses ordinal suffix (legacy/edge case)', () => {
    expect(formatRecurrenceBadge('monthly', 2)).toBe('Monthly · 2nd')
    expect(formatRecurrenceBadge('monthly', 11)).toBe('Monthly · 11th')
    expect(formatRecurrenceBadge('monthly', 15)).toBe('Monthly · 15th')
  })
})

// ---------------------------------------------------------------------------
// Date constants — all times are 10:00 UTC, well before/after Copenhagen midnight
// CPH = UTC+2 in summer (CEST), so 10:00 UTC = 12:00 CPH — unambiguously one date.
// ---------------------------------------------------------------------------

const FRI_SEP_4  = new Date('2026-09-04T10:00:00.000Z') // Friday  Sep 4
const SAT_SEP_5  = new Date('2026-09-05T10:00:00.000Z') // Saturday Sep 5
const SUN_SEP_6  = new Date('2026-09-06T10:00:00.000Z') // Sunday  Sep 6
const MON_SEP_7  = new Date('2026-09-07T10:00:00.000Z') // Monday  Sep 7

// ---------------------------------------------------------------------------
// computeFirstOccurrence — daily / weekly / weekdays
// ---------------------------------------------------------------------------

describe('computeFirstOccurrence — daily/weekly/weekdays', () => {
  it('[5] daily → today', () => {
    expect(computeFirstOccurrence('daily', null, FRI_SEP_4)).toBe('2026-09-04')
  })

  it('[6] weekly → today', () => {
    expect(computeFirstOccurrence('weekly', null, FRI_SEP_4)).toBe('2026-09-04')
  })

  it('[7] weekdays on a Friday → today', () => {
    expect(computeFirstOccurrence('weekdays', null, FRI_SEP_4)).toBe('2026-09-04')
  })

  it('[8] weekdays on a Saturday → next Monday (Sep 7)', () => {
    expect(computeFirstOccurrence('weekdays', null, SAT_SEP_5)).toBe('2026-09-07')
  })

  it('[9] weekdays on a Sunday → next Monday (Sep 7)', () => {
    expect(computeFirstOccurrence('weekdays', null, SUN_SEP_6)).toBe('2026-09-07')
  })

  it('[10] weekdays on a Monday → today (Mon Sep 7)', () => {
    expect(computeFirstOccurrence('weekdays', null, MON_SEP_7)).toBe('2026-09-07')
  })
})

// ---------------------------------------------------------------------------
// computeFirstOccurrence — specific weekday
// ---------------------------------------------------------------------------

describe('computeFirstOccurrence — specific weekday', () => {
  it('[11] fri on a Friday → today (Sep 4)', () => {
    expect(computeFirstOccurrence('fri', null, FRI_SEP_4)).toBe('2026-09-04')
  })

  it('[12] sat on a Friday → tomorrow (Sep 5)', () => {
    expect(computeFirstOccurrence('sat', null, FRI_SEP_4)).toBe('2026-09-05')
  })

  it('[13] mon on a Friday → 3 days forward (Sep 7)', () => {
    expect(computeFirstOccurrence('mon', null, FRI_SEP_4)).toBe('2026-09-07')
  })

  it('[14] thu on a Friday → 6 days forward (Sep 10)', () => {
    expect(computeFirstOccurrence('thu', null, FRI_SEP_4)).toBe('2026-09-10')
  })

  it('[15] sun on a Friday → 2 days forward (Sep 6)', () => {
    expect(computeFirstOccurrence('sun', null, FRI_SEP_4)).toBe('2026-09-06')
  })

  it('[16] mon on a Monday → today (Sep 7)', () => {
    expect(computeFirstOccurrence('mon', null, MON_SEP_7)).toBe('2026-09-07')
  })
})

// ---------------------------------------------------------------------------
// computeFirstOccurrence — monthly
// FRI_SEP_4 = Sep 4, dom = 4
// ---------------------------------------------------------------------------

describe('computeFirstOccurrence — monthly', () => {
  it('[17] monthly day=4 on Sep 4 → today (Sep 4)', () => {
    expect(computeFirstOccurrence('monthly', 4, FRI_SEP_4)).toBe('2026-09-04')
  })

  it('[18] monthly day=10 on Sep 4 → Sep 10 (still this month)', () => {
    expect(computeFirstOccurrence('monthly', 10, FRI_SEP_4)).toBe('2026-09-10')
  })

  it('[19] monthly day=1 on Sep 4 → Oct 1 (day already passed this month)', () => {
    expect(computeFirstOccurrence('monthly', 1, FRI_SEP_4)).toBe('2026-10-01')
  })

  it('[20] monthly day=30 on Sep 4 → Sep 30', () => {
    expect(computeFirstOccurrence('monthly', 30, FRI_SEP_4)).toBe('2026-09-30')
  })

  it('[21] monthly day=31 in Sep → Sep 30 (clamped; Sep has 30 days, 30 >= 4)', () => {
    expect(computeFirstOccurrence('monthly', 31, FRI_SEP_4)).toBe('2026-09-30')
  })

  it('[22] monthly day=31 on Oct 31 → Oct 31 (target ≥ today dom)', () => {
    const oct31 = new Date('2026-10-31T10:00:00.000Z')
    expect(computeFirstOccurrence('monthly', 31, oct31)).toBe('2026-10-31')
  })
})

// ---------------------------------------------------------------------------
// computeFirstOccurrence — Copenhagen timezone boundary
//
// Europe/Copenhagen in summer = CEST = UTC+2.
// 2026-09-04T22:01Z  →  2026-09-05 00:01 CPH  →  CPH date = Saturday Sep 5
// ---------------------------------------------------------------------------

// CPH Sep 5 = Saturday (Sep 4 22:01 UTC = Sep 5 00:01 CEST)
const CPH_SAT_SEP_5 = new Date('2026-09-04T22:01:00.000Z')

describe('computeFirstOccurrence — Copenhagen timezone boundary', () => {
  it('[23] daily at 22:01 UTC (00:01 CPH Sep 5) → Sep 5', () => {
    expect(computeFirstOccurrence('daily', null, CPH_SAT_SEP_5)).toBe('2026-09-05')
  })

  it('[24] sat (Saturday) at CPH Sep 5 → today (Sep 5)', () => {
    expect(computeFirstOccurrence('sat', null, CPH_SAT_SEP_5)).toBe('2026-09-05')
  })

  it('[25] monthly day=5 at CPH Sep 5 → Sep 5 (today matches)', () => {
    expect(computeFirstOccurrence('monthly', 5, CPH_SAT_SEP_5)).toBe('2026-09-05')
  })

  it('[26] monthly day=4 at CPH Sep 5 → Oct 4 (day 4 < dom 5)', () => {
    expect(computeFirstOccurrence('monthly', 4, CPH_SAT_SEP_5)).toBe('2026-10-04')
  })

  it('[27] weekdays at CPH Sep 5 (Saturday) → next Monday Sep 7', () => {
    expect(computeFirstOccurrence('weekdays', null, CPH_SAT_SEP_5)).toBe('2026-09-07')
  })

  it('[28] sun at CPH Sep 5 (Saturday) → next Sunday Sep 6', () => {
    expect(computeFirstOccurrence('sun', null, CPH_SAT_SEP_5)).toBe('2026-09-06')
  })
})

// ---------------------------------------------------------------------------
// Monthly first / last day — v1 UI options
//
// day=1  → "first day of month"
// day=31 → "last day of month" (clamped to month length)
//
// Reference: FRI_SEP_4 = Sep 4 2026 (dom=4), CPH_SAT_SEP_5 = Sep 5 CPH
// ---------------------------------------------------------------------------

describe('computeFirstOccurrence — monthly first/last day', () => {
  it('[29] first day (day=1) on Sep 4 → Oct 1 (day 1 already passed)', () => {
    expect(computeFirstOccurrence('monthly', 1, FRI_SEP_4)).toBe('2026-10-01')
  })

  it('[30] last day (day=31) on Sep 4 → Sep 30 (clamped; 30 >= dom 4)', () => {
    expect(computeFirstOccurrence('monthly', 31, FRI_SEP_4)).toBe('2026-09-30')
  })

  it('[31] last day (day=31) on Oct 31 → Oct 31 (today is last day)', () => {
    const oct31 = new Date('2026-10-31T10:00:00.000Z')
    expect(computeFirstOccurrence('monthly', 31, oct31)).toBe('2026-10-31')
  })

  it('[32] last day (day=31) on Nov 30 → Nov 30 (Nov has 30 days)', () => {
    const nov30 = new Date('2026-11-30T10:00:00.000Z')
    expect(computeFirstOccurrence('monthly', 31, nov30)).toBe('2026-11-30')
  })

  it('[33] first day (day=1) on Jan 1 → today (dom=1 >= 1)', () => {
    const jan1 = new Date('2027-01-01T10:00:00.000Z')
    expect(computeFirstOccurrence('monthly', 1, jan1)).toBe('2027-01-01')
  })

  it('[34] formatRecurrenceBadge for first day shows "Monthly · first day"', () => {
    expect(formatRecurrenceBadge('monthly', 1)).toBe('Monthly · first day')
  })

  it('[35] formatRecurrenceBadge for last day shows "Monthly · last day"', () => {
    expect(formatRecurrenceBadge('monthly', 31)).toBe('Monthly · last day')
  })
})
