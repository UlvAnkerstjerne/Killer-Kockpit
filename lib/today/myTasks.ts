// lib/today/myTasks.ts
//
// Pure builder for the Today "My tasks" card.
//
// One deduplicated collection feeds both the rows and the header count, so the
// two cannot drift apart. A task can legitimately be fetched by several queries
// (e.g. it is pending my review AND matches the due-this-week query), but it is
// shown and counted exactly once, in its most specific section:
//   review   → returned → due-date groups.
//
// Grouping uses the Europe/Copenhagen calendar day and instant-based deadlines
// (the same semantics as getDueState): due before `now` is overdue; due later
// today is "today"; anything else is upcoming; no due date is its own group.

import { copenhagenMidnightUTC } from './weekUtils'

export type TaskGroupKey = 'overdue' | 'today' | 'upcoming' | 'no_date'

export const TASK_GROUP_LABELS: Record<TaskGroupKey, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  upcoming: 'Upcoming',
  no_date: 'No due date',
}

const GROUP_ORDER: TaskGroupKey[] = ['overdue', 'today', 'upcoming', 'no_date']

export type DuedTask = {
  id: string
  title: string
  priority: number
  due_at: string | null
}

export type MyTasks<R extends { id: string }, T extends { id: string }, D extends DuedTask> = {
  review: R[]
  returned: T[]
  groups: { key: TaskGroupKey; label: string; items: D[] }[]
  /** Total rows rendered across review, returned and every group. */
  count: number
}

export function classifyTaskGroup(dueAt: string | null, now: Date): TaskGroupKey {
  if (!dueAt) return 'no_date'
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) return 'no_date'
  if (due < now) return 'overdue'

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10)
  const tomorrowStart = copenhagenMidnightUTC(get('year'), get('month'), get('day') + 1)

  return due < tomorrowStart ? 'today' : 'upcoming'
}

/** Critical (1) → Normal (2) → Low (3) → Background (4); unknown priorities last. */
function priorityRank(p: number): number {
  return Number.isInteger(p) && p >= 1 && p <= 4 ? p : 99
}

export function compareDuedTasks(a: DuedTask, b: DuedTask): number {
  const pr = priorityRank(a.priority) - priorityRank(b.priority)
  if (pr !== 0) return pr

  const at = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY
  const bt = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY
  if (at !== bt) return at < bt ? -1 : 1

  const title = a.title.localeCompare(b.title)
  if (title !== 0) return title
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function uniqueById<X extends { id: string }>(rows: X[], seen: Set<string>): X[] {
  const out: X[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}

export function buildMyTasks<R extends { id: string }, T extends { id: string }, D extends DuedTask>(
  input: { pendingReview: R[]; returned: T[]; tasks: D[]; now: Date },
): MyTasks<R, T, D> {
  const seen = new Set<string>()
  const review = uniqueById(input.pendingReview, seen)
  const returned = uniqueById(input.returned, seen)
  const dued = uniqueById(input.tasks, seen)

  const buckets: Record<TaskGroupKey, D[]> = { overdue: [], today: [], upcoming: [], no_date: [] }
  for (const task of dued) buckets[classifyTaskGroup(task.due_at, input.now)].push(task)

  const groups = GROUP_ORDER
    .map(key => ({ key, label: TASK_GROUP_LABELS[key], items: buckets[key].sort(compareDuedTasks) }))
    .filter(g => g.items.length > 0)

  const count = review.length + returned.length + groups.reduce((n, g) => n + g.items.length, 0)
  return { review, returned, groups, count }
}
