// lib/today/todoUtils.ts
//
// Pure helpers for the To-Do feature.
// No side effects — safe to unit-test without mocking.
//
// All week-boundary logic delegates to getCopenhagenWeekBounds from weekUtils,
// so the Copenhagen Monday–Sunday definition is defined in exactly one place.

import type { Todo } from '@/lib/types'
import { getCopenhagenWeekBounds } from './weekUtils'

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Sorts open to-dos by priority ascending (1=Critical first), then
 * by created_at descending (newest first within the same priority).
 *
 * Does NOT mutate the input array.
 */
export function sortOpenTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

// ---------------------------------------------------------------------------
// Completed-this-week filter
// ---------------------------------------------------------------------------

/**
 * Returns todos whose completed_at falls within the current Copenhagen
 * Monday–Sunday week that contains `now`.
 *
 * Completed todos from previous weeks are excluded.
 * Todos that are not completed (completed_at === null) are excluded.
 */
export function filterCompletedThisWeek(todos: Todo[], now: Date): Todo[] {
  const { weekStart, weekEnd } = getCopenhagenWeekBounds(now)
  return todos.filter((t) => {
    if (!t.completed_at) return false
    const ts = new Date(t.completed_at).getTime()
    return ts >= weekStart.getTime() && ts < weekEnd.getTime()
  })
}

/**
 * Derives the display status from a Todo's timestamps.
 * Convenience helper — avoids scattered conditional chains.
 */
export function getTodoStatus(todo: Pick<Todo, 'completed_at' | 'cancelled_at'>): 'open' | 'completed' | 'cancelled' {
  if (todo.completed_at) return 'completed'
  if (todo.cancelled_at) return 'cancelled'
  return 'open'
}
