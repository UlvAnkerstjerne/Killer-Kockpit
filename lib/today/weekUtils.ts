// lib/today/weekUtils.ts
//
// Pure helpers for the weekly work overview dashboard.
// All date calculations are performed in the Europe/Copenhagen timezone.
// No side effects — safe to unit-test without mocking.

const TZ = 'Europe/Copenhagen'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DueState = 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'no_date'

export type WorkItem = {
  id: string
  kind: 'task' | 'waiting_on'
  title: string
  priority: number          // 1 (Critical) – 4 (Background)
  due_at: string | null
  done_at: string | null    // completed_at (task) or fulfilled_at (waiting_on); null = unfinished
  href: string
  ownerName?: string        // for management view
}

// ---------------------------------------------------------------------------
// Week bounds
// ---------------------------------------------------------------------------

/**
 * Returns the UTC instants that correspond to:
 *   weekStart — Monday 00:00:00 Europe/Copenhagen of the week containing `now`
 *   weekEnd   — the following Monday 00:00:00 Europe/Copenhagen (exclusive upper bound)
 */
export function getCopenhagenWeekBounds(now: Date): { weekStart: Date; weekEnd: Date } {
  // 1. Find the calendar date of `now` in Copenhagen.
  const { y: cYear, m: cMonth, d: cDay } = getCopenhagenDateParts(now)

  // 2. Compute the day-of-week in Copenhagen (0=Sun, 1=Mon … 6=Sat).
  //    Use a UTC-based Date for this arithmetic (the Copenhagen calendar date
  //    is correct; we only need the weekday).
  const dow = new Date(Date.UTC(cYear, cMonth - 1, cDay)).getUTCDay()
  const daysToMonday = dow === 0 ? -6 : 1 - dow

  // 3. Monday calendar date (handles month/year overflow automatically).
  const mondayDay = cDay + daysToMonday

  // 4. Convert to UTC instants.
  const weekStart = copenhagenMidnightUTC(cYear, cMonth, mondayDay)
  const weekEnd   = copenhagenMidnightUTC(cYear, cMonth, mondayDay + 7)

  return { weekStart, weekEnd }
}

/**
 * Returns the UTC instant that corresponds to 00:00:00 on the given calendar
 * date in the Europe/Copenhagen timezone.
 * month is 1-indexed.  day may overflow (e.g. day=32) — JS Date handles it.
 */
export function copenhagenMidnightUTC(year: number, month: number, day: number): Date {
  // Start with UTC midnight as a reference.
  const utcMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0))

  // Find what time UTC midnight shows in Copenhagen (always +1h or +2h ahead).
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcMidnight)

  const rh  = parseInt(p.find(x => x.type === 'hour')!.value)
  const rm  = parseInt(p.find(x => x.type === 'minute')!.value)
  const rs  = parseInt(p.find(x => x.type === 'second')!.value)

  // Copenhagen midnight = UTC midnight − Copenhagen offset
  const offsetMs = (rh * 3600 + rm * 60 + rs) * 1000
  return new Date(utcMidnight.getTime() - offsetMs)
}

// ---------------------------------------------------------------------------
// Due-state classification
// ---------------------------------------------------------------------------

/**
 * Classifies a due_at timestamp relative to the current moment and week.
 *
 * weekEnd is the exclusive upper bound of the current week (next Mon 00:00 Copenhagen).
 * Items at or beyond weekEnd are classified as 'no_date' (they should not appear in
 * the weekly list, but we handle them gracefully here).
 */
export function getDueState(dueAt: string | null, now: Date, weekEnd: Date): DueState {
  if (!dueAt) return 'no_date'

  const due = new Date(dueAt)
  if (due >= weekEnd) return 'no_date'

  // Overdue: the due instant is in the past.
  if (due < now) return 'overdue'

  // Compare calendar dates in Copenhagen for today/tomorrow.
  const { y: ny, m: nm, d: nd } = getCopenhagenDateParts(now)
  const { y: dy, m: dm, d: dd } = getCopenhagenDateParts(due)

  if (dy === ny && dm === nm && dd === nd) return 'today'

  const tomorrowStart      = copenhagenMidnightUTC(ny, nm, nd + 1)
  const dayAfterTomorrow   = copenhagenMidnightUTC(ny, nm, nd + 2)

  if (due >= tomorrowStart && due < dayAfterTomorrow) return 'tomorrow'

  return 'this_week'
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Sorts a mixed array of tasks and waiting-ons for the weekly work list.
 *
 * Order:
 *   1. Unfinished, overdue   — priority ASC → due_at ASC → id ASC
 *   2. Unfinished, this week — priority ASC → due_at ASC → id ASC
 *   3. Finished (done_at set) — done_at DESC (most recently done first)
 */
export function sortWorkItems(items: WorkItem[], now: Date): WorkItem[] {
  const undone = items.filter(i => i.done_at === null)
  const done   = items.filter(i => i.done_at !== null)

  undone.sort((a, b) => {
    // Group: overdue (0) vs this-week (1)
    const aGroup = a.due_at && new Date(a.due_at) < now ? 0 : 1
    const bGroup = b.due_at && new Date(b.due_at) < now ? 0 : 1
    if (aGroup !== bGroup) return aGroup - bGroup

    // Priority (1 = Critical is highest, so ascending = Critical first)
    if (a.priority !== b.priority) return a.priority - b.priority

    // Due date ascending (nulls last, though undone items always have due_at here)
    if (a.due_at !== b.due_at) {
      if (!a.due_at) return 1
      if (!b.due_at) return -1
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
    }

    // Stable tie-breaker
    return a.id.localeCompare(b.id)
  })

  done.sort((a, b) => {
    if (!a.done_at) return 1
    if (!b.done_at) return -1
    return new Date(b.done_at).getTime() - new Date(a.done_at).getTime()
  })

  return [...undone, ...done]
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Returns e.g. "6 Jan – 12 Jan" for the week header.
 * weekEnd is the exclusive bound (next Mon 00:00), so Sunday = weekEnd − 1 ms.
 */
export function formatCopenhagenWeekRange(weekStart: Date, weekEnd: Date): string {
  const sunday = new Date(weekEnd.getTime() - 1)
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' })
  return `${fmt(weekStart)} – ${fmt(sunday)}`
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCopenhagenDateParts(date: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  return {
    y: parseInt(parts.find(p => p.type === 'year')!.value),
    m: parseInt(parts.find(p => p.type === 'month')!.value),  // 1-indexed
    d: parseInt(parts.find(p => p.type === 'day')!.value),
  }
}
