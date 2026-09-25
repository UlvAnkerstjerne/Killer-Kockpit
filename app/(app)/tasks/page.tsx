import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import TaskList from '@/components/tasks/TaskList'
import EmptyState from '@/components/ui/EmptyState'
import type { ViewMode } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; status?: string }>
}) {
  const [user, params, allUsers] = await Promise.all([getCurrentUser(), searchParams, getActiveUsers()])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const statusFilter = params.status

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

  if (view === 'personal') {
    query = query.eq('owner_user_id', user.id)
  }

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  } else {
    // Default: hide done/cancelled unless filtered
    query = query.not('status', 'in', '("done","cancelled")')
  }

  const { data: tasks, error } = await query

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

  return (
    <div className="-m-4 p-4 min-h-screen bg-kraft-light">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Tasks</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            {view === 'management' ? 'All organisation tasks' : 'Your tasks'}
          </p>
        </div>
        <Link
          href="/tasks/new"
          className="px-4 py-2 bg-[#171717] text-kraft-light text-sm font-medium rounded-lg hover:opacity-80 transition-opacity [box-shadow:3px_3px_0_#555555]"
        >
          New task
        </Link>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-4">
        {STATUS_FILTERS.map(({ label, value }) => (
          <Link
            key={value}
            href={`/tasks?view=${view}${value ? `&status=${value}` : ''}`}
            className={[
              'text-xs px-3 py-1.5 rounded-lg transition-colors',
              (statusFilter || '') === value
                ? 'bg-[#171717] text-kraft-light font-semibold'
                : 'text-kk-muted hover:bg-[#B7A486]/25 hover:text-kk-ink',
            ].join(' ')}
          >
            {label}
          </Link>
        ))}
      </div>

      {!tasks || tasks.length === 0 ? (
        <div className="bg-kraft-light border-2 border-[#171717] rounded-lg px-6 py-14 text-center [box-shadow:4px_4px_0_#555555]">
          <div className="text-sm font-semibold text-kk-ink mb-1">No tasks</div>
          <div className="text-sm text-kk-muted">
            {view === 'personal' ? 'Tasks assigned to you appear here.' : 'No tasks match this filter.'}
          </div>
        </div>
      ) : (
        <TaskList tasks={tasks} currentUser={user} allUsers={allUsers} showProject={true} />
      )}
    </div>
  )
}
