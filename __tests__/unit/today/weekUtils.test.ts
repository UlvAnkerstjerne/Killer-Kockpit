/**
 * Unit tests for lib/today/weekUtils.ts
 *
 * All date assertions are performed against known UTC instants that correspond
 * to specific Europe/Copenhagen local times, computed via the mkCph() helper.
 *
 * Test matrix (18 cases):
 *   [1-4]   getCopenhagenWeekBounds — week boundary semantics
 *   [5-10]  getDueState — classification
 *   [11-18] sortWorkItems — ordering and lifecycle grouping
 */

import { describe, it, expect } from 'vitest'
import {
  getCopenhagenWeekBounds,
  getDueState,
  sortWorkItems,
} from '@/lib/today/weekUtils'
import type { WorkItem } from '@/lib/today/weekUtils'

// ---------------------------------------------------------------------------
// Test helper: create a UTC Date whose Copenhagen-rendered time matches localStr
// ---------------------------------------------------------------------------

/**
 * Returns the UTC Date that corresponds to the given Europe/Copenhagen local time.
 * localStr: 'YYYY-MM-DDTHH:mm:ss'
 */
function mkCph(localStr: string): Date {
  const TZ = 'Europe/Copenhagen'
  const [datePart, timePart = '00:00:00'] = localStr.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const [h, min, s = 0] = timePart.split(':').map(Number)

  // Start with a UTC candidate that treats the local time as if it were UTC
  const utcNominal = new Date(Date.UTC(y, m - 1, d, h, min, s))

  // Find what Copenhagen time that UTC instant shows
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcNominal)

  const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value)
  const ry = get('year'), rm = get('month'), rd = get('day')
  const rh = get('hour'), rmin = get('minute'), rs = get('second')

  // The offset between "what Copenhagen shows" and "what we want"
  const renderedMs = Date.UTC(ry, rm - 1, rd, rh, rmin, rs)
  const wantedMs   = Date.UTC(y, m - 1, d, h, min, s)
  const diffMs     = renderedMs - wantedMs  // positive when Copenhagen is ahead of UTC

  return new Date(utcNominal.getTime() - diffMs)
}

// ---------------------------------------------------------------------------
// Test fixtures
// All weeks use ISO week 2 of 2024: Mon 8 Jan – Sun 14 Jan
// ---------------------------------------------------------------------------

const MON_JAN_08 = mkCph('2024-01-08T00:00:00')
const SUN_JAN_14 = mkCph('2024-01-14T23:59:59')
const MON_JAN_15 = mkCph('2024-01-15T00:00:00')

// A reference "now" mid-week: Wednesday 10 Jan at 14:00 Copenhagen
const NOW_WED = mkCph('2024-01-10T14:00:00')
const { weekStart: WS, weekEnd: WE } = getCopenhagenWeekBounds(NOW_WED)

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    kind: 'task',
    title: overrides.id,
    priority: 2,
    due_at: null,
    done_at: null,
    href: `/${overrides.id}`,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// [1-4] getCopenhagenWeekBounds
// ---------------------------------------------------------------------------

describe('getCopenhagenWeekBounds', () => {
  it('[1] Monday 00:00 Copenhagen is the exact week start', () => {
    const { weekStart } = getCopenhagenWeekBounds(MON_JAN_08)
    // weekStart should equal the UTC instant for Mon 8 Jan 00:00 Copenhagen
    expect(weekStart.getTime()).toBe(MON_JAN_08.getTime())
  })

  it('[2] Sunday 23:59 Copenhagen belongs to the same week as Monday 00:00', () => {
    const { weekStart: wsMon } = getCopenhagenWeekBounds(MON_JAN_08)
    const { weekStart: wsSun } = getCopenhagenWeekBounds(SUN_JAN_14)
    expect(wsMon.getTime()).toBe(wsSun.getTime())
  })

  it('[3] Sunday 23:00 Copenhagen (UTC Monday ~22:00) is still in the current week', () => {
    const sun23 = mkCph('2024-01-14T23:00:00')
    const { weekStart, weekEnd } = getCopenhagenWeekBounds(MON_JAN_08)
    expect(sun23.getTime()).toBeGreaterThanOrEqual(weekStart.getTime())
    expect(sun23.getTime()).toBeLessThan(weekEnd.getTime())
  })

  it('[4] Next Monday 00:00 Copenhagen starts a new week exactly 7 days later', () => {
    const { weekStart: ws1 } = getCopenhagenWeekBounds(SUN_JAN_14)
    const { weekStart: ws2 } = getCopenhagenWeekBounds(MON_JAN_15)
    expect(ws2.getTime()).toBeGreaterThan(ws1.getTime())
    expect(ws2.getTime() - ws1.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// [5-10] getDueState
// ---------------------------------------------------------------------------

describe('getDueState', () => {
  it('[5] null due_at → no_date', () => {
    expect(getDueState(null, NOW_WED, WE)).toBe('no_date')
  })

  it('[6] due_at before now → overdue', () => {
    const yesterday = mkCph('2024-01-09T10:00:00').toISOString()
    expect(getDueState(yesterday, NOW_WED, WE)).toBe('overdue')
  })

  it('[7] due_at same calendar day as now but after now → today', () => {
    const laterToday = mkCph('2024-01-10T15:00:00').toISOString()  // 15:00 > NOW_WED 14:00
    expect(getDueState(laterToday, NOW_WED, WE)).toBe('today')
  })

  it('[8] due_at on the next calendar day in Copenhagen → tomorrow', () => {
    const tomorrow = mkCph('2024-01-11T09:00:00').toISOString()
    expect(getDueState(tomorrow, NOW_WED, WE)).toBe('tomorrow')
  })

  it('[9] due_at later this week (not today or tomorrow) → this_week', () => {
    const saturday = mkCph('2024-01-13T10:00:00').toISOString()
    expect(getDueState(saturday, NOW_WED, WE)).toBe('this_week')
  })

  it('[10] due_at at or beyond weekEnd → no_date (next week item)', () => {
    const nextMonday = mkCph('2024-01-15T09:00:00').toISOString()
    expect(getDueState(nextMonday, NOW_WED, WE)).toBe('no_date')
  })
})

// ---------------------------------------------------------------------------
// [11-18] sortWorkItems
// ---------------------------------------------------------------------------

describe('sortWorkItems', () => {
  it('[11] overdue items sort before this-week items regardless of priority', () => {
    const items: WorkItem[] = [
      makeItem({ id: 'b', priority: 1, due_at: mkCph('2024-01-12T10:00:00').toISOString() }),  // this week, priority 1
      makeItem({ id: 'a', priority: 2, due_at: mkCph('2024-01-09T10:00:00').toISOString() }),  // overdue, priority 2
    ]
    const sorted = sortWorkItems(items, NOW_WED)
    expect(sorted.map(i => i.id)).toEqual(['a', 'b'])
  })

  it('[12] within the same group, lower priority number wins (Critical=1 before Normal=2)', () => {
    const items: WorkItem[] = [
      makeItem({ id: 'b', priority: 2, due_at: mkCph('2024-01-09T08:00:00').toISOString() }),  // overdue, p2
      makeItem({ id: 'a', priority: 1, due_at: mkCph('2024-01-09T12:00:00').toISOString() }),  // overdue, p1 but later
    ]
    const sorted = sortWorkItems(items, NOW_WED)
    // a (priority 1) wins even though its due_at is later
    expect(sorted.map(i => i.id)).toEqual(['a', 'b'])
  })

  it('[13] same priority, earlier due_at sorts first', () => {
    const items: WorkItem[] = [
      makeItem({ id: 'b', priority: 2, due_at: mkCph('2024-01-09T12:00:00').toISOString() }),
      makeItem({ id: 'a', priority: 2, due_at: mkCph('2024-01-09T10:00:00').toISOString() }),
    ]
    const sorted = sortWorkItems(items, NOW_WED)
    expect(sorted.map(i => i.id)).toEqual(['a', 'b'])
  })

  it('[14] same priority and same due_at → stable lexicographic tie-break by id', () => {
    const sameTime = mkCph('2024-01-09T10:00:00').toISOString()
    const items: WorkItem[] = [
      makeItem({ id: 'z', priority: 2, due_at: sameTime }),
      makeItem({ id: 'a', priority: 2, due_at: sameTime }),
      makeItem({ id: 'm', priority: 2, due_at: sameTime }),
    ]
    const sorted = sortWorkItems(items, NOW_WED)
    expect(sorted.map(i => i.id)).toEqual(['a', 'm', 'z'])
  })

  it('[15] finished items (done_at set) go to the bottom after all unfinished', () => {
    const items: WorkItem[] = [
      makeItem({ id: 'done', done_at: mkCph('2024-01-10T09:00:00').toISOString(), due_at: mkCph('2024-01-09T10:00:00').toISOString() }),
      makeItem({ id: 'open', due_at: mkCph('2024-01-09T10:00:00').toISOString() }),
    ]
    const sorted = sortWorkItems(items, NOW_WED)
    expect(sorted[0].id).toBe('open')
    expect(sorted[1].id).toBe('done')
  })

  it('[16] multiple done items sort by done_at DESC (most recently done first)', () => {
    const items: WorkItem[] = [
      makeItem({ id: 'early', done_at: mkCph('2024-01-08T09:00:00').toISOString() }),
      makeItem({ id: 'late',  done_at: mkCph('2024-01-10T11:00:00').toISOString() }),
      makeItem({ id: 'mid',   done_at: mkCph('2024-01-09T15:00:00').toISOString() }),
    ]
    const sorted = sortWorkItems(items, NOW_WED)
    expect(sorted.map(i => i.id)).toEqual(['late', 'mid', 'early'])
  })

  it('[17] full ordering: overdue → this-week → done', () => {
    const items: WorkItem[] = [
      makeItem({ id: 'done',      done_at: mkCph('2024-01-10T08:00:00').toISOString(), due_at: mkCph('2024-01-08T00:00:00').toISOString() }),
      makeItem({ id: 'this-week', priority: 1, due_at: mkCph('2024-01-12T10:00:00').toISOString() }),
      makeItem({ id: 'overdue',   priority: 2, due_at: mkCph('2024-01-09T10:00:00').toISOString() }),
    ]
    const sorted = sortWorkItems(items, NOW_WED)
    expect(sorted.map(i => i.id)).toEqual(['overdue', 'this-week', 'done'])
  })

  it('[18] item due exactly at weekEnd is classified as no_date (next week)', () => {
    // weekEnd is Mon 15 Jan 00:00 Copenhagen. An item due exactly then is next week.
    const atWeekEnd = WE.toISOString()
    expect(getDueState(atWeekEnd, NOW_WED, WE)).toBe('no_date')
  })
})
