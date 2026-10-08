// lib/tasks/tasks-url.ts
//
// URL + person-selection helpers for /tasks and /todos. Pure, so the rules are testable.
//
//   /tasks                              → the signed-in user's own tasks
//   /tasks?owner=<user-id>              → that team member's tasks (management only)
//   /tasks?owner=<user-id>&status=open  → status tabs keep the selected person
//   /todos, /todos?owner=<user-id>      → same idea for to-dos
//
// The owner param is only honoured for management users, and only for active management users.
// Anything else (malformed, a non-management user's id, or any param sent by a non-manager)
// falls back to the signed-in user.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only well-formed ids are ever used as a filter; anything else is ignored. */
export function sanitizeOwnerParam(owner: string | null | undefined): string | null {
  return owner && UUID.test(owner) ? owner.toLowerCase() : null
}

const STATUSES = new Set(['proposed', 'open', 'in_progress', 'blocked', 'pending_review', 'done', 'cancelled'])

export function sanitizeStatusParam(status: string | null | undefined): string | null {
  return status && STATUSES.has(status) ? status : null
}

export type TeamPerson = { id: string; display_name: string }

/** Preferred left-to-right order of the selector; anyone else follows alphabetically. */
const PERSON_ORDER = ['ulv', 'kasper', 'adam', 'lydia', 'sara']

export function orderPeople<T extends { display_name: string }>(people: T[]): T[] {
  const rank = (p: T) => {
    const i = PERSON_ORDER.indexOf(p.display_name.split(' ')[0].toLowerCase())
    return i === -1 ? PERSON_ORDER.length : i
  }
  return [...people].sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name))
}

export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName
}

/**
 * Whose items to show. Non-management users are always themselves. Management users may pick any
 * active management team member from `people`; an unknown / malformed owner falls back to themselves.
 */
export function resolveSelectedOwner(args: {
  isManagement: boolean
  currentUserId: string
  ownerParam: string | null | undefined
  people: readonly TeamPerson[]
}): string {
  if (!args.isManagement) return args.currentUserId
  const wanted = sanitizeOwnerParam(args.ownerParam)
  if (!wanted) return args.currentUserId
  return args.people.some(p => p.id.toLowerCase() === wanted) ? wanted : args.currentUserId
}

/** /tasks URL. The signed-in user's own view has no owner param. */
export function tasksHref({ owner, status }: { owner?: string | null; status?: string | null }): string {
  const params = new URLSearchParams()
  if (owner) params.set('owner', owner)
  if (status) params.set('status', status)
  const qs = params.toString()
  return qs ? `/tasks?${qs}` : '/tasks'
}

/** /todos URL, optionally keeping a returnTo. */
export function todosHref({ owner, returnTo }: { owner?: string | null; returnTo?: string | null }): string {
  const params = new URLSearchParams()
  if (owner) params.set('owner', owner)
  if (returnTo) params.set('returnTo', returnTo)
  const qs = params.toString()
  return qs ? `/todos?${qs}` : '/todos'
}
