// lib/todos/recurrence.ts
//
// Pure helpers for recurring to-do logic.
// No side effects — safe to unit-test without mocking.
// All date arithmetic uses the Europe/Copenhagen timezone.

const TZ = 'Europe/Copenhagen'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecurrenceRule =
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
  | 'monthly'

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const DAY_NAMES: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday',  sat: 'Saturday', sun: 'Sunday',
}

/** Human-readable badge for a recurrence rule. */
export function formatRecurrenceBadge(rule: string, day?: number | null): string {
  switch (rule) {
    case 'daily':    return 'Daily'
    case 'weekdays': return 'Every weekday'
    case 'weekly':   return 'Weekly'
    case 'monthly':
      if (day === 1)  return 'Monthly · first day'
      if (day === 31) return 'Monthly · last day'
      return day ? `Monthly · ${day}${ordinalSuffix(day)}` : 'Monthly'
    default: return DAY_NAMES[rule] ? `Every ${DAY_NAMES[rule]}` : rule
  }
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return 'th'
  switch (n % 10) {
    case 1:  return 'st'
    case 2:  return 'nd'
    case 3:  return 'rd'
    default: return 'th'
  }
}

// ---------------------------------------------------------------------------
// First occurrence
// ---------------------------------------------------------------------------

/**
 * Computes the first scheduled_for date (YYYY-MM-DD in Copenhagen) for a new
 * recurring to-do created at `now`.
 *
 * - daily / weekly  → today in Copenhagen
 * - weekdays        → today if Mon–Fri, else next Monday
 * - mon–sun         → today if it matches the weekday, else next occurrence (1–6 days)
 * - monthly         → this month's `day` if ≥ today's day-of-month (clamped to
 *                     month length), else the same day next month
 */
export function computeFirstOccurrence(rule: RecurrenceRule, day: number | null, now: Date): string {
  const todayStr  = now.toLocaleDateString('en-CA', { timeZone: TZ }) // 'YYYY-MM-DD'
  const [year, month, dom] = todayStr.split('-').map(Number)

  if (rule === 'daily' || rule === 'weekly') return todayStr

  if (rule === 'weekdays') {
    const isodow = utcIsodow(year, month, dom)
    if (isodow <= 5) return todayStr               // Mon–Fri: today
    const daysToMon = isodow === 6 ? 2 : 1         // Sat→+2, Sun→+1
    return offsetDate(year, month, dom, daysToMon)
  }

  if (rule === 'monthly') {
    const target       = day!
    const lastThis     = daysInMonth(year, month)
    const clampedThis  = Math.min(target, lastThis)
    if (clampedThis >= dom) return isoDate(year, month, clampedThis)
    // Target day already passed this month → next month
    const [ny, nm] = nextMonthYM(year, month)
    return isoDate(ny, nm, Math.min(target, daysInMonth(ny, nm)))
  }

  // Specific weekday (mon–sun)
  const targetIsodow = DOW_ISO[rule]!
  const todayIsodow  = utcIsodow(year, month, dom)
  if (todayIsodow === targetIsodow) return todayStr // today matches
  const daysUntil = ((targetIsodow - todayIsodow + 7) % 7) || 7
  return offsetDate(year, month, dom, daysUntil)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DOW_ISO: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }

/** ISO day-of-week for a calendar date (1=Mon … 7=Sun). */
function utcIsodow(y: number, m: number, d: number): number {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun
  return dow === 0 ? 7 : dow
}

/** Number of days in the given month (1-indexed). */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Next month as [year, month]. */
function nextMonthYM(y: number, m: number): [number, number] {
  return m === 12 ? [y + 1, 1] : [y, m + 1]
}

/** Returns 'YYYY-MM-DD' for (year, month, day + offset), handling overflow. */
function offsetDate(y: number, m: number, d: number, offset: number): string {
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().split('T')[0]
}

/** Returns 'YYYY-MM-DD' for an exact calendar date. */
function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
