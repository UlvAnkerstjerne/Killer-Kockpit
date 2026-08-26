import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canEditTask, canAssignToOthers } from '@/lib/permissions'
import { TaskStatusBadge, PriorityBadge } from '@/components/ui/StatusBadge'
import AuditHistory from '@/components/ui/AuditHistory'
import TaskForm from '@/components/tasks/TaskForm'
import TaskActionButtons from '@/components/tasks/TaskActionButtons'

export const dynamic = 'force-dynamic'

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [user, allUsers] = await Promise.all([getCurrentUser(), getActiveUsers()])
  if (!user) return null

  const supabase = await createClient()

  const { data: task, error } = await supabase
    .from('tasks')
    .select(`
      *,
      owner:owner_user_id (id, display_name, email),
      creator:created_by_user_id (id, display_name),
      project:project_id (id, title)
    `)
    .eq('id', id)
    .single()

  if (error || !task) notFound()

  const { data: projects } = await supabase
    .from('projects')
    .select('id, title')
    .is('archived_at', null)
    .not('status', 'eq', 'completed')
    .order('title')

  const canEdit = canEditTask(user.role, task.owner_user_id, user.id)
  const owner = Array.isArray(task.owner) ? task.owner[0] : task.owner
  const creator = Array.isArray(task.creator) ? task.creator[0] : task.creator
  const project = Array.isArray(task.project) ? task.project[0] : task.project

  const now = new Date()
  const dueAt = task.due_at ? new Date(task.due_at) : null
  const isOverdue = dueAt && dueAt < now && task.status !== 'done' && task.status !== 'cancelled'
  const isDueToday = dueAt && dueAt.toDateString() === now.toDateString()

  return (
    <div className="max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-kk-muted mb-4">
        <Link href="/tasks" className="hover:text-kk-ink transition-colors">Tasks</Link>
        {project && (
          <>
            <span>/</span>
            <Link href={`/projects/${project.id}`} className="hover:text-kk-ink transition-colors">
              {project.title}
            </Link>
          </>
        )}
        <span>/</span>
        <span className="text-kk-ink truncate">{task.title}</span>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Main */}
        <div className="col-span-2 space-y-6">
          {/* Task info + edit */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="flex items-start justify-between px-5 py-4 border-b border-kk-line">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl font-bold tracking-tight text-kk-ink">{task.title}</h1>
                  <TaskStatusBadge status={task.status} />
                  {task.priority === 1 && <PriorityBadge priority={1} />}
                </div>
                {task.description && (
                  <p className="text-sm text-kk-muted mt-1">{task.description}</p>
                )}
              </div>
            </div>

            {canEdit && task.status !== 'done' && task.status !== 'cancelled' && (
              <div className="p-5 border-b border-kk-line">
                <TaskActionButtons taskId={task.id} currentStatus={task.status} />
              </div>
            )}

            {canEdit && (
              <div className="p-5">
                <h2 className="text-sm font-semibold text-kk-ink mb-4">Edit task</h2>
                <TaskForm
                  mode="edit"
                  task={task}
                  currentUser={user}
                  allUsers={canAssignToOthers(user.role) ? allUsers : [{ id: user.id, display_name: user.display_name, email: user.email }]}
                  projects={projects || []}
                />
              </div>
            )}
          </div>

          {/* History */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">History</h2>
            </div>
            <div className="px-5 py-2">
              <AuditHistory entityType="task" entityId={task.id} />
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 space-y-3">
            <div>
              <div className="text-xs text-kk-muted mb-0.5">Owner</div>
              <div className="text-sm font-semibold text-kk-ink">{owner?.display_name || '—'}</div>
            </div>

            <div>
              <div className="text-xs text-kk-muted mb-0.5">Status</div>
              <TaskStatusBadge status={task.status} />
            </div>

            <div>
              <div className="text-xs text-kk-muted mb-0.5">Priority</div>
              <PriorityBadge priority={task.priority} />
            </div>

            {dueAt && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Due</div>
                <div className={`text-sm font-medium ${isOverdue ? 'text-kk-bad' : isDueToday ? 'text-kk-warn' : 'text-kk-ink'}`}>
                  {dueAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  {' '}
                  {dueAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  {isOverdue && ' · Overdue'}
                  {isDueToday && !isOverdue && ' · Today'}
                </div>
              </div>
            )}

            {project && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Project</div>
                <Link
                  href={`/projects/${project.id}`}
                  className="text-sm text-kk-ink hover:underline"
                >
                  {project.title}
                </Link>
              </div>
            )}

            {task.completed_at && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Completed</div>
                <div className="text-sm text-kk-good">
                  {new Date(task.completed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </div>
              </div>
            )}

            <div className="border-t border-kk-line pt-3">
              <div className="text-xs text-kk-muted mb-0.5">Created by</div>
              <div className="text-sm text-kk-ink">{creator?.display_name || '—'}</div>
              <div className="text-xs text-kk-muted mt-0.5">
                {new Date(task.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
