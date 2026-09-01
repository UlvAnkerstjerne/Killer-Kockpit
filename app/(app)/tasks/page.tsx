import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
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
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const statusFilter = params.status

  const supabase = await createClient()

  let query = supabase
    .from('tasks')
    .select(`
      id, title, status, priority, due_at, completed_at, owner_user_id,
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
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Tasks</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            {view === 'management' ? 'All organisation tasks' : 'Your tasks'}
          </p>
        </div>
        <Link
          href="/tasks/new"
          className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
        >
          New task
        </Link>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-4 bg-white border border-kk-line rounded-xl p-1 w-fit">
        {STATUS_FILTERS.map(({ label, value }) => (
          <Link
            key={value}
            href={`/tasks?view=${view}${value ? `&status=${value}` : ''}`}
            className={[
              'text-xs px-3 py-1.5 rounded-lg transition-colors',
              (statusFilter || '') === value
                ? 'bg-kk-ink text-white font-medium'
                : 'text-kk-muted hover:text-kk-ink',
            ].join(' ')}
          >
            {label}
          </Link>
        ))}
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl">
        {!tasks || tasks.length === 0 ? (
          <EmptyState
            title="No tasks"
            description={view === 'personal' ? 'Tasks assigned to you appear here.' : 'No tasks match this filter.'}
          />
        ) : (
          <TaskList tasks={tasks} currentUser={user} showProject={true} />
        )}
      </div>
    </div>
  )
}
