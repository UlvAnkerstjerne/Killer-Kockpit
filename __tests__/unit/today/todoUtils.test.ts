/**
 * Unit tests for lib/today/todoUtils.ts
 *
 * Test matrix (17 cases):
 *   [1-5]   sortOpenTodos — priority order, created_at tie-break, no mutation
 *   [6-12]  filterCompletedThisWeek — boundary conditions, null exclusion
 *   [13-17] getTodoStatus — derived status logic
 */

import { describe, it, expect } from 'vitest'
import { sortOpenTodos, filterCompletedThisWeek, getTodoStatus, filterTodosForToday } from '@/lib/today/todoUtils'
import type { Todo } from '@/lib/types'

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

let _seq = 1
function makeTodo(overrides: Partial<Todo> = {}): Todo {
  const id = `todo-${_seq++}`
  return {
    id,
    user_id: 'user-1',
    title: `Todo ${id}`,
    priority: 2,
    created_at: '2024-01-10T10:00:00.000Z',
    updated_at: '2024-01-10T10:00:00.000Z',
    completed_at: null,
    cancelled_at: null,
    notes: null,
    scheduled_for: null,
    recurrence_rule: null,
    recurrence_day: null,
    parent_todo_id: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// sortOpenTodos
// ---------------------------------------------------------------------------

describe('sortOpenTodos', () => {
  it('[1] sorts by priority ascending (1 before 4)', () => {
    const todos = [
      makeTodo({ priority: 4 }),
      makeTodo({ priority: 1 }),
      makeTodo({ priority: 3 }),
      makeTodo({ priority: 2 }),
    ]
    const result = sortOpenTodos(todos)
    expect(result.map(t => t.priority)).toEqual([1, 2, 3, 4])
  })

  it('[2] within the same priority, sorts by created_at descending (newest first)', () => {
    const older = makeTodo({ priority: 2, created_at: '2024-01-01T00:00:00.000Z' })
    const newer = makeTodo({ priority: 2, created_at: '2024-01-10T00:00:00.000Z' })
    const result = sortOpenTodos([older, newer])
    expect(result[0].id).toBe(newer.id)
    expect(result[1].id).toBe(older.id)
  })

  it('[3] priority trumps created_at (older critical before newer normal)', () => {
    const oldCritical = makeTodo({ priority: 1, created_at: '2024-01-01T00:00:00.000Z' })
    const newNormal   = makeTodo({ priority: 2, created_at: '2024-01-10T00:00:00.000Z' })
    const result = sortOpenTodos([newNormal, oldCritical])
    expect(result[0].priority).toBe(1)
  })

  it('[4] does not mutate the input array', () => {
    const t1 = makeTodo({ priority: 3 })
    const t2 = makeTodo({ priority: 1 })
    const input = [t1, t2]
    sortOpenTodos(input)
    expect(input[0].id).toBe(t1.id) // unchanged
  })

  it('[5] handles empty array', () => {
    expect(sortOpenTodos([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// filterCompletedThisWeek — week = Mon 8 Jan – Sun 14 Jan 2024 Copenhagen
// ---------------------------------------------------------------------------

// Copenhagen is UTC+1 in January (CET). Week Mon 2024-01-08 00:00 CPH = 2024-01-07T23:00Z
// Week end Mon 2024-01-15 00:00 CPH = 2024-01-14T23:00Z

const WEEK_MON_UTC = '2024-01-07T23:00:00.000Z' // Mon 00:00 CPH
const WEEK_SUN_UTC = '2024-01-14T22:59:59.000Z' // Sun 23:59 CPH (just before week end)
const WEEK_END_UTC = '2024-01-14T23:00:00.000Z' // Mon 15 Jan 00:00 CPH (exclusive boundary)
const PREV_SUN_UTC = '2024-01-07T22:59:59.000Z' // previous Sunday 23:59 CPH

// "now" = Wednesday 10 Jan 2024 12:00 CPH = 11:00 UTC
const NOW = new Date('2024-01-10T11:00:00.000Z')

describe('filterCompletedThisWeek', () => {
  it('[6] includes a todo completed in the middle of the week', () => {
    const todo = makeTodo({ completed_at: '2024-01-10T11:00:00.000Z' }) // Wed midday
    expect(filterCompletedThisWeek([todo], NOW)).toHaveLength(1)
  })

  it('[7] includes a todo completed at exactly the week start boundary', () => {
    const todo = makeTodo({ completed_at: WEEK_MON_UTC })
    expect(filterCompletedThisWeek([todo], NOW)).toHaveLength(1)
  })

  it('[8] includes a todo completed at the last second of the week (Sun 23:59 CPH)', () => {
    const todo = makeTodo({ completed_at: WEEK_SUN_UTC })
    expect(filterCompletedThisWeek([todo], NOW)).toHaveLength(1)
  })

  it('[9] excludes a todo completed before the week start (previous Sunday)', () => {
    const todo = makeTodo({ completed_at: PREV_SUN_UTC })
    expect(filterCompletedThisWeek([todo], NOW)).toHaveLength(0)
  })

  it('[10] excludes a todo completed at the exclusive week-end boundary', () => {
    const todo = makeTodo({ completed_at: WEEK_END_UTC })
    expect(filterCompletedThisWeek([todo], NOW)).toHaveLength(0)
  })

  it('[11] excludes todos where completed_at is null', () => {
    const todo = makeTodo({ completed_at: null })
    expect(filterCompletedThisWeek([todo], NOW)).toHaveLength(0)
  })

  it('[12] filters correctly from a mixed list', () => {
    const inWeek   = makeTodo({ completed_at: '2024-01-10T11:00:00.000Z' })
    const outWeek  = makeTodo({ completed_at: PREV_SUN_UTC })
    const noCompl  = makeTodo({ completed_at: null })
    const result = filterCompletedThisWeek([inWeek, outWeek, noCompl], NOW)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(inWeek.id)
  })
})

// ---------------------------------------------------------------------------
// getTodoStatus
// ---------------------------------------------------------------------------

describe('getTodoStatus', () => {
  it('[13] returns "open" when both timestamps are null', () => {
    expect(getTodoStatus({ completed_at: null, cancelled_at: null })).toBe('open')
  })

  it('[14] returns "completed" when completed_at is set', () => {
    expect(getTodoStatus({ completed_at: '2024-01-10T10:00:00.000Z', cancelled_at: null })).toBe('completed')
  })

  it('[15] returns "cancelled" when cancelled_at is set', () => {
    expect(getTodoStatus({ completed_at: null, cancelled_at: '2024-01-10T10:00:00.000Z' })).toBe('cancelled')
  })

  it('[16] returns "completed" when completed_at takes precedence (checked first)', () => {
    // Per getTodoStatus implementation: completed_at is checked before cancelled_at
    expect(getTodoStatus({
      completed_at: '2024-01-10T10:00:00.000Z',
      cancelled_at: '2024-01-09T10:00:00.000Z',
    })).toBe('completed')
  })

  it('[17] works with Todo objects from the full interface', () => {
    const todo = makeTodo({ completed_at: '2024-01-10T10:00:00.000Z' })
    expect(getTodoStatus(todo)).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// filterTodosForToday
// ---------------------------------------------------------------------------

describe('filterTodosForToday', () => {
  const TODAY = '2026-09-04'

  it('[18] non-recurring todo (recurrence_rule=null) is always included', () => {
    const todo = makeTodo({ recurrence_rule: null, scheduled_for: null })
    expect(filterTodosForToday([todo], TODAY)).toHaveLength(1)
  })

  it('[19] recurring todo with scheduled_for = today is included', () => {
    const todo = makeTodo({ recurrence_rule: 'daily', scheduled_for: '2026-09-04' })
    expect(filterTodosForToday([todo], TODAY)).toHaveLength(1)
  })

  it('[20] recurring todo with scheduled_for in the past is included', () => {
    const todo = makeTodo({ recurrence_rule: 'weekly', scheduled_for: '2026-09-01' })
    expect(filterTodosForToday([todo], TODAY)).toHaveLength(1)
  })

  it('[21] recurring todo with scheduled_for tomorrow is excluded', () => {
    const todo = makeTodo({ recurrence_rule: 'daily', scheduled_for: '2026-09-05' })
    expect(filterTodosForToday([todo], TODAY)).toHaveLength(0)
  })

  it('[22] recurring todo with scheduled_for far in the future is excluded', () => {
    const todo = makeTodo({ recurrence_rule: 'monthly', scheduled_for: '2026-10-04', recurrence_day: 4 })
    expect(filterTodosForToday([todo], TODAY)).toHaveLength(0)
  })

  it('[23] recurring todo with null scheduled_for (safety fallback) is included', () => {
    const todo = makeTodo({ recurrence_rule: 'daily', scheduled_for: null })
    expect(filterTodosForToday([todo], TODAY)).toHaveLength(1)
  })

  it('[24] filters a mixed list correctly', () => {
    const nonRecurring   = makeTodo({ recurrence_rule: null })
    const dueToday       = makeTodo({ recurrence_rule: 'daily', scheduled_for: '2026-09-04' })
    const overdue        = makeTodo({ recurrence_rule: 'weekly', scheduled_for: '2026-08-28' })
    const futureTomorrow = makeTodo({ recurrence_rule: 'daily', scheduled_for: '2026-09-05' })
    const futureDistant  = makeTodo({ recurrence_rule: 'monthly', scheduled_for: '2026-10-04', recurrence_day: 4 })

    const result = filterTodosForToday(
      [nonRecurring, dueToday, overdue, futureTomorrow, futureDistant],
      TODAY,
    )

    expect(result).toHaveLength(3)
    expect(result.map(t => t.id)).toEqual([nonRecurring.id, dueToday.id, overdue.id])
  })
})
