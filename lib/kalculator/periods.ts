/**
 * lib/kalculator/periods.ts
 *
 * Store Manager Dashboard periods as Killer Kalculator defines them
 * (index.html getCphDateRange): Europe/Copenhagen calendar dates, inclusive
 * start, exclusive end — the /api/sales-range contract.
 *
 *   today      [today, tomorrow)
 *   yesterday  [yesterday, today)
 *   week       [Monday of this week, tomorrow)
 *   month      [1st of this month, tomorrow)
 */

export type StorePeriod = 'today' | 'yesterday' | 'week' | 'month'
export const STORE_PERIODS: readonly StorePeriod[] = ['today', 'yesterday', 'week', 'month']

export interface DateRange {
  start: string
  end: string
}

export function cphDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Calendar-day arithmetic on YYYY-MM-DD (UTC, DST-safe). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export function kalculatorPeriodRange(period: StorePeriod, now: Date = new Date()): DateRange {
  const today = cphDate(now)
  const tomorrow = addDays(today, 1)
  switch (period) {
    case 'today':
      return { start: today, end: tomorrow }
    case 'yesterday':
      return { start: addDays(today, -1), end: today }
    case 'week': {
      const weekday = new Date(today + 'T12:00:00Z').getUTCDay() // Sun=0
      return { start: addDays(today, -(weekday === 0 ? 6 : weekday - 1)), end: tomorrow }
    }
    case 'month':
      return { start: today.slice(0, 7) + '-01', end: tomorrow }
  }
}
