import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import TaskList from '@/components/tasks/TaskList'
import EmptyState from '@/components/ui/EmptyState'
import { resolveView } from '@/lib/view'
import { MANAGEMENT_ROLES, canAccessManagementView } from '@/lib/permissions'
import { orderPeople, sanitizeOwnerParam, sanitizeStatusParam, tasksHref } from '@/lib/tasks/tasks-url'
import type { ViewMode } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; status?: string; owner?: string }>
}) {
  const [user, params, allUsers] = await Promise.all([getCurrentUser(), searchParams, getActiveUsers()])
  if (!user) return null

  // Management is explicit (?view=management) and role-gated; everyone else is always "My tasks".
  const view: ViewMode = resolveView(user.role, params.view)
  const isEveryone = view === 'management'
  const statusFilter = sanitizeStatusParam(params.status)
  // Owner filter only exists in Everyone's tasks view. It narrows the query; it never widens access
  // (the query still runs as the signed-in user, so RLS decides what is visible).
  const ownerFilter = isEveryone ? sanitizeOwnerParam(params.owner) : null

  const supabase = await createClient()

  let query = supabase
    .from('tasks')
    .select(`
      id, title, status, priority, due_at, completed_at, owner_user_id, created_by_user_id,
      owner:owner_user_id (id, display_name, email),
      project:project_id (id, title)
    `)
    .is('archived_at', null)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })

  if (!isEveryone) {
    query = query.eq('owner_user_id', user.id)
  } else if (ownerFilter) {
    query = query.eq('owner_user_id', ownerFilter)
  }

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  } else {
    // Default: hide done/cancelled unless filtered
    query = query.not('status', 'in', '("done","cancelled")')
  }

  const [{ data: tasks, error }, peopleRes] = await Promise.all([
    query,
    isEveryone
      ? supabase.from('app_users').select('id, display_name').eq('active', true).in('role', MANAGEMENT_ROLES)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ])
  const people = orderPeople((peopleRes.data ?? []) as { id: string; display_name: string }[])
  // Someone outside the management list (e.g. a MEMBER) can still be selected via the URL.
  const selectedPerson = ownerFilter && !people.some(p => p.id === ownerFilter)
    ? allUsers.find(u => u.id === ownerFilter) ?? null
    : null

  if (error) {
    return (
      <div className="p-4 rounded-xl bg-kk-bad-bg border border-red-200 text-kk-bad text-sm">
        Failed to load tasks. Please refresh.
      </div>
    )
  }

  const STATUS_FILTERS = [
    { label: 'Active', value: '' },
    { label: 'Open', value: 'open' },
    { label: 'In progress', value: 'in_progress' },
    { label: 'Blocked', value: 'blocked' },
    { label: 'Done', value: 'done' },
    { label: 'Cancelled', value: 'cancelled' },
  ]

  const chip = (active: boolean) => [
    'text-xs px-3 py-1.5 rounded-lg transition-colors',
    active
      ? 'bg-[#171717] text-kraft-light font-semibold'
      : 'text-kk-muted hover:bg-[#B7A486]/25 hover:text-kk-ink',
  ].join(' ')

  return (
    <div className="-m-4 p-4 min-h-screen bg-kraft-light">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Tasks</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            {isEveryone ? "Everyone's tasks" : 'My tasks'}
          </p>
        </div>
        <Link
          href="/tasks/new"
          className="shrink-0 px-4 py-2 bg-[#171717] text-kraft-light text-sm font-medium rounded-lg hover:opacity-80 transition-opacity [box-shadow:3px_3px_0_#555555]"
        >
          New task
        </Link>
      </div>

      {/* My tasks / Everyone's tasks — management only */}
      {canAccessManagementView(user.role) && (
        <div role="group" aria-label="Tasks view" className="flex flex-wrap gap-1 mb-3">
          <Link href={tasksHref({ view: 'personal', status: statusFilter })} aria-current={!isEveryone ? 'page' : undefined} className={chip(!isEveryone)}>
            My tasks
          </Link>
          <Link href={tasksHref({ view: 'management', status: statusFilter, owner: ownerFilter })} aria-current={isEveryone ? 'page' : undefined} className={chip(isEveryone)}>
            Everyone&apos;s tasks
          </Link>
        </div>
      )}

      {/* Person filter — Everyone's tasks only */}
      {isEveryone && (
        <div role="group" aria-label="Filter by person" className="flex flex-wrap gap-1 mb-3">
          <Link href={tasksHref({ view: 'management', status: statusFilter })} aria-current={!ownerFilter ? 'page' : undefined} className={chip(!ownerFilter)}>
            All
          </Link>
          {people.map(p => (
            <Link key={p.id} href={tasksHref({ view: 'management', status: statusFilter, owner: p.id })} aria-current={ownerFilter === p.id ? 'page' : undefined} className={chip(ownerFilter === p.id)}>
              {p.display_name.split(' ')[0]}
            </Link>
          ))}
          {selectedPerson && (
            <Link href={tasksHref({ view: 'management', status: statusFilter, owner: selectedPerson.id })} aria-current="page" className={chip(true)}>
              {selectedPerson.display_name.split(' ')[0]}
            </Link>
          )}
        </div>
      )}

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-1 mb-4">
        {STATUS_FILTERS.map(({ label, value }) => (
          <Link
            key={value}
            href={tasksHref({ view, status: value || null, owner: ownerFilter })}
            aria-current={(statusFilter || '') === value ? 'page' : undefined}
            className={chip((statusFilter || '') === value)}
          >
            {label}
          </Link>
        ))}
      </div>

      {!tasks || tasks.length === 0 ? (
        <div className="bg-kraft-light border-2 border-[#171717] rounded-lg px-6 py-14 text-center [box-shadow:4px_4px_0_#555555]">
          <div className="text-sm font-semibold text-kk-ink mb-1">No tasks</div>
          <div className="text-sm text-kk-muted">
            {!isEveryone ? 'Tasks assigned to you appear here.' : 'No tasks match this filter.'}
          </div>
        </div>
      ) : (
        <TaskList tasks={tasks} currentUser={user} allUsers={allUsers} showProject={true} />
      )}
    </div>
  )
}
