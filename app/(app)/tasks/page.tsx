import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { MANAGEMENT_ROLES, canAccessManagementView } from '@/lib/permissions'
import TaskList from '@/components/tasks/TaskList'
import PersonPills from '@/components/people/PersonPills'
import { ownedBy } from '@/lib/view'
import {
  orderPeople, resolveSelectedOwner, sanitizeStatusParam, tasksHref, type TeamPerson,
} from '@/lib/tasks/tasks-url'

export const dynamic = 'force-dynamic'

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; owner?: string }>
}) {
  const [user, params, allUsers] = await Promise.all([getCurrentUser(), searchParams, getActiveUsers()])
  if (!user) return null

  const supabase = await createClient()
  const isManagement = canAccessManagementView(user.role)
  const statusFilter = sanitizeStatusParam(params.status)

  // The team selector lists active management users. Only management users see it, and only
  // they can pick someone else; everyone else is always themselves, whatever the URL says.
  const peopleRes = isManagement
    ? await supabase.from('app_users').select('id, display_name').eq('active', true).in('role', MANAGEMENT_ROLES)
    : { data: [] as TeamPerson[] }
  const people = orderPeople((peopleRes.data ?? []) as TeamPerson[])
  const selectedId = resolveSelectedOwner({
    isManagement, currentUserId: user.id, ownerParam: params.owner, people,
  })
  const viewingOwn = selectedId === user.id

  // The query runs as the signed-in user, so RLS still decides what is visible; the owner filter
  // only narrows it.
  let query = supabase
    .from('tasks')
    .select(`
      id, title, status, priority, due_at, completed_at, owner_user_id, created_by_user_id,
      owner:owner_user_id (id, display_name, email),
      project:project_id (id, title)
    `)
    .is('archived_at', null)
    .eq('owner_user_id', selectedId)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  } else {
    // Default: hide done/cancelled unless filtered
    query = query.not('status', 'in', '("done","cancelled")')
  }

  const { data: rawTasks, error } = await query
  // Defence in depth: keep only the selected person's tasks even if a read returned more.
  const tasks = rawTasks ? ownedBy(rawTasks, selectedId, 'owner_user_id') : rawTasks

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

  // Own view has no owner param; other people's views keep theirs.
  const ownerParamFor = (id: string) => (id === user.id ? null : id)

  return (
    <div className="-m-4 p-4 min-h-screen bg-kraft-light">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Tasks</h1>
        <Link
          href="/tasks/new"
          className="shrink-0 px-4 py-2 bg-[#171717] text-kraft-light text-sm font-medium rounded-lg hover:opacity-80 transition-opacity [box-shadow:3px_3px_0_#555555]"
        >
          New task
        </Link>
      </div>

      {isManagement && (
        <PersonPills
          people={people}
          selectedId={selectedId}
          hrefFor={id => tasksHref({ owner: ownerParamFor(id), status: statusFilter })}
        />
      )}

      {/* Status filter tabs — keep the selected person */}
      <div className="flex flex-wrap gap-1 mb-4">
        {STATUS_FILTERS.map(({ label, value }) => {
          const active = (statusFilter || '') === value
          return (
            <Link
              key={value}
              href={tasksHref({ owner: ownerParamFor(selectedId), status: value || null })}
              aria-current={active ? 'page' : undefined}
              className={[
                'text-xs px-3 py-1.5 rounded-lg transition-colors',
                active
                  ? 'bg-[#171717] text-kraft-light font-semibold'
                  : 'text-kk-muted hover:bg-[#B7A486]/25 hover:text-kk-ink',
              ].join(' ')}
            >
              {label}
            </Link>
          )
        })}
      </div>

      {!tasks || tasks.length === 0 ? (
        <div className="bg-kraft-light border-2 border-[#171717] rounded-lg px-6 py-14 text-center [box-shadow:4px_4px_0_#555555]">
          <div className="text-sm font-semibold text-kk-ink mb-1">No tasks</div>
          <div className="text-sm text-kk-muted">
            {viewingOwn ? 'Tasks assigned to you appear here.' : 'No tasks match this filter.'}
          </div>
        </div>
      ) : (
        <TaskList tasks={tasks} currentUser={user} allUsers={allUsers} showProject={true} />
      )}
    </div>
  )
}
