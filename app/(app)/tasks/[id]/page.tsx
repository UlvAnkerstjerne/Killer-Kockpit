import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import {
  canEditTaskTerms,
  canRequestTaskChange,
  canReviewChangeRequest,
  canUpdateTaskStatus,
  canAssignToOthers,
  canManageTaskDriveReferences,
} from '@/lib/permissions'
import { getGoogleConnectionStatus, hasDriveScope } from '@/lib/google/auth'
import { getEntityDriveFiles } from '@/lib/actions/drive'
import { TaskStatusBadge, PriorityBadge } from '@/components/ui/StatusBadge'
import AuditHistory from '@/components/ui/AuditHistory'
import TaskForm from '@/components/tasks/TaskForm'
import TaskActionButtons from '@/components/tasks/TaskActionButtons'
import RelatedFilesSection from '@/components/drive/RelatedFilesSection'
import ChangeRequestForm from './ChangeRequestForm'
import PendingChangeRequests from './PendingChangeRequests'
import GmailProvenance from '@/components/ui/GmailProvenance'

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
  const googleStatus = await getGoogleConnectionStatus(user.id)

  const { data: task, error } = await supabase
    .from('tasks')
    .select(`
      *,
      owner:owner_user_id (id, display_name, email),
      creator:created_by_user_id (id, display_name),
      returned_by:returned_by_user_id (id, display_name),
      project:project_id (id, title),
      meeting:meeting_id (id, title)
    `)
    .eq('id', id)
    .single()

  if (error || !task) notFound()

  const [{ data: projects }, { data: pendingRequests }, driveFiles] = await Promise.all([
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived","cancelled")')
      .order('title'),
    supabase
      .from('change_requests')
      .select('*, requester:requester_id (id, display_name, email)')
      .eq('entity_type', 'task')
      .eq('entity_id', id)
      .eq('status', 'pending')
      .order('created_at'),
    getEntityDriveFiles('task', id),
  ])

  const canEditTerms   = canEditTaskTerms(user.role, task.created_by_user_id, user.id)
  const canRequestChange = canRequestTaskChange(user.role, task.created_by_user_id, task.owner_user_id, user.id)
  const canReviewRequests = canReviewChangeRequest(user.role, task.created_by_user_id, user.id)
  const canActOnStatus = canUpdateTaskStatus(user.role, task.created_by_user_id, task.owner_user_id, user.id)
  const driveEnabled   = googleStatus.connected && hasDriveScope(googleStatus.scopes)
  const canDriveManage = canManageTaskDriveReferences(
    user.role, task.created_by_user_id, task.owner_user_id, user.id, task.status
  )

  // Handoff context — relationship flags are derived from task data only.
  // isSuperAdmin is passed separately for secondary admin override UI.
  const isSelfAssigned    = task.owner_user_id === task.created_by_user_id
  const userIsResponsible = task.owner_user_id === user.id
  const userIsRequester   = task.created_by_user_id === user.id
  const isSuperAdmin      = user.role === 'SUPER_ADMIN'

  const owner       = Array.isArray(task.owner)       ? task.owner[0]       : task.owner
  const creator     = Array.isArray(task.creator)     ? task.creator[0]     : task.creator
  const returnedBy  = Array.isArray(task.returned_by) ? task.returned_by[0] : task.returned_by
  const project     = Array.isArray(task.project)     ? task.project[0]     : task.project
  const meeting     = Array.isArray(task.meeting)     ? task.meeting[0]     : task.meeting

  const now    = new Date()
  const dueAt  = task.due_at ? new Date(task.due_at) : null
  const isOverdue = dueAt && dueAt < now && task.status !== 'done' && task.status !== 'cancelled'
  const isDueToday = dueAt && dueAt.toDateString() === now.toDateString()

  // Show "Returned" banner when the task was sent back and is not yet resubmitted
  const isReturned = !!task.returned_at && task.status !== 'pending_review' && task.status !== 'done' && task.status !== 'cancelled'

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

            {/* Returned banner */}
            {isReturned && (
              <div className="px-5 py-3 bg-amber-50 border-b border-amber-200">
                <p className="text-xs font-semibold text-amber-800 mb-0.5">
                  Returned by {returnedBy?.display_name || 'requester'}
                </p>
                {task.latest_review_note ? (
                  <p className="text-sm text-amber-900">{task.latest_review_note}</p>
                ) : (
                  <p className="text-xs text-amber-700">No note left.</p>
                )}
              </div>
            )}

            {canActOnStatus && (
              <div className="p-5 border-b border-kk-line">
                <TaskActionButtons
                  taskId={task.id}
                  currentStatus={task.status}
                  isSelfAssigned={isSelfAssigned}
                  userIsResponsible={userIsResponsible}
                  userIsRequester={userIsRequester}
                  isSuperAdmin={isSuperAdmin}
                />
              </div>
            )}

            {canEditTerms && (
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

            {canRequestChange && task.status !== 'done' && task.status !== 'cancelled' && (
              <div className="p-5 border-t border-kk-line">
                <h2 className="text-sm font-semibold text-kk-ink mb-3">Request change</h2>
                <p className="text-xs text-kk-muted mb-3">
                  You cannot edit commitment terms directly. Submit a request and the task creator will be notified.
                </p>
                <ChangeRequestForm taskId={task.id} currentDueAt={task.due_at ?? null} />
              </div>
            )}
          </div>

          {/* Pending change requests (visible to reviewer) */}
          {canReviewRequests && pendingRequests && pendingRequests.length > 0 && (
            <PendingChangeRequests requests={pendingRequests} />
          )}

          {/* History */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">History</h2>
            </div>
            <div className="px-5 py-2">
              <Suspense fallback={<div className="py-4 text-xs text-kk-muted">Loading history…</div>}>
                <AuditHistory entityType="task" entityId={task.id} />
              </Suspense>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 space-y-3">
            {/* Two-role display — always explicit regardless of self-assignment */}
            <div>
              <div className="text-xs text-kk-muted mb-0.5">Requested by</div>
              <div className="text-sm font-semibold text-kk-ink">{creator?.display_name || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-kk-muted mb-0.5">Responsible</div>
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

            {meeting && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Created from</div>
                <Link
                  href={`/meetings/${meeting.id}`}
                  className="text-sm text-kk-ink hover:underline"
                >
                  {meeting.title}
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

            <Suspense fallback={null}>
              <GmailProvenance entityType="task" entityId={task.id} currentUserId={user.id} />
            </Suspense>

            <div className="border-t border-kk-line pt-3">
              <div className="text-xs text-kk-muted mb-0.5">Created</div>
              <div className="text-xs text-kk-muted">
                {new Date(task.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              </div>
            </div>
          </div>

          {/* Related Drive files */}
          <RelatedFilesSection
            entityType="task"
            entityId={task.id}
            initialFiles={driveFiles}
            canManage={canDriveManage}
            driveEnabled={driveEnabled}
          />
        </div>
      </div>
    </div>
  )
}
