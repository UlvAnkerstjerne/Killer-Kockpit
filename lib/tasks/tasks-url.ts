// lib/tasks/tasks-url.ts
//
// URL helpers for the /tasks page. Pure, so the "preserve view / owner / status" rules are testable.
//
//   /tasks                                  → My tasks
//   /tasks?view=management                  → Everyone's tasks
//   /tasks?view=management&owner=<user-id>  → one person's tasks
//   status=<status> is carried across view and owner changes.

import type { ViewMode } from '@/lib/types'

export type TasksUrlState = {
  view: ViewMode
  status?: string | null
  owner?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only well-formed ids are ever used as a filter; anything else is ignored. */
export function sanitizeOwnerParam(owner: string | null | undefined): string | null {
  return owner && UUID.test(owner) ? owner.toLowerCase() : null
}

const STATUSES = new Set(['proposed', 'open', 'in_progress', 'blocked', 'pending_review', 'done', 'cancelled'])

export function sanitizeStatusParam(status: string | null | undefined): string | null {
  return status && STATUSES.has(status) ? status : null
}

/** Build a /tasks URL. Owner is only meaningful (and only emitted) in Everyone's-tasks view. */
export function tasksHref({ view, status, owner }: TasksUrlState): string {
  const params = new URLSearchParams()
  if (view === 'management') {
    params.set('view', 'management')
    if (owner) params.set('owner', owner)
  }
  if (status) params.set('status', status)
  const qs = params.toString()
  return qs ? `/tasks?${qs}` : '/tasks'
}

/** Preferred left-to-right order for the person filter; anyone else follows alphabetically. */
const PERSON_ORDER = ['ulv', 'kasper', 'adam', 'lydia', 'sara']

export function orderPeople<T extends { display_name: string }>(people: T[]): T[] {
  const rank = (p: T) => {
    const i = PERSON_ORDER.indexOf(p.display_name.split(' ')[0].toLowerCase())
    return i === -1 ? PERSON_ORDER.length : i
  }
  return [...people].sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name))
}
