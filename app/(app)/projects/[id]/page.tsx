import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canEditProject } from '@/lib/permissions'
import { getGoogleConnectionStatus, hasDriveScope } from '@/lib/google/auth'
import { getEntityDriveFiles } from '@/lib/actions/drive'
import { ProjectStatusBadge } from '@/components/ui/StatusBadge'
import { WaitingOnStatusBadge } from '@/components/ui/WaitingOnStatusBadge'
import { DecisionStatusBadge } from '@/components/ui/DecisionStatusBadge'
import { MeetingStatusBadge } from '@/components/ui/MeetingStatusBadge'
import AuditHistory from '@/components/ui/AuditHistory'
import ProjectForm from '@/components/projects/ProjectForm'
import TaskList from '@/components/tasks/TaskList'
import ProjectLifecycleButtons from '@/components/projects/ProjectLifecycleButtons'
import RelatedFilesSection from '@/components/drive/RelatedFilesSection'
import type { WaitingStatus, DecisionStatus, MeetingStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [user, allUsers] = await Promise.all([getCurrentUser(), getActiveUsers()])
  if (!user) return null

  const supabase = await createClient()
  const googleStatus = await getGoogleConnectionStatus(user.id)

  const { data: project, error } = await supabase
    .from('projects')
    .select(`
      *,
      owner:owner_user_id (id, display_name, email),
      creator:created_by_user_id (id, display_name)
    `)
    .eq('id', id)
    .single()

  if (error || !project) notFound()

  const [{ data: tasks }, { data: waitingOns }, { data: decisions }, { data: meetings }, driveFiles] = await Promise.all([
    supabase
      .from('tasks')
      .select(`
        id, title, status, priority, due_at, completed_at, owner_user_id,
        owner:owner_user_id (id, display_name, email)
      `)
      .eq('project_id', id)
      .is('archived_at', null)
      .order('created_at', { ascending: false }),

    supabase
      .from('waiting_ons')
      .select(`
        id, title, status, due_at, waiting_for_name,
        owner:owner_user_id (id, display_name),
        waiting_for_user:waiting_for_user_id (id, display_name)
      `)
      .eq('project_id', id)
      .is('archived_at', null)
      .order('due_at', { ascending: true, nullsFirst: false }),

    supabase
      .from('decisions')
      .select(`
        id, title, status, decided_at,
        owner:owner_user_id (id, display_name)
      `)
      .eq('project_id', id)
      .is('archived_at', null)
      .order('created_at', { ascending: false }),

    supabase
      .from('meetings')
      .select(`
        id, title, status, scheduled_start,
        owner:owner_user_id (id, display_name)
      `)
      .eq('project_id', id)
      .not('status', 'eq', 'cancelled')
      .order('scheduled_start', { ascending: false }),

    getEntityDriveFiles('project', id),
  ])

  const canEdit            = canEditProject(user.role, project.owner_user_id, user.id)
  const driveEnabled       = googleStatus.connected && hasDriveScope(googleStatus.scopes)
  const owner = Array.isArray(project.owner) ? project.owner[0] : project.owner
  const creator = Array.isArray(project.creator) ? project.creator[0] : project.creator

  const isOverdue = project.due_date && new Date(project.due_date) < new Date() && project.status !== 'completed'

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
            <Link href="/projects" className="hover:text-kk-ink transition-colors">Projects</Link>
            <span>/</span>
            <span className="text-kk-ink">{project.title}</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-kk-ink">{project.title}</h1>
            <ProjectStatusBadge status={project.status} />
          </div>
          {project.description && (
            <p className="text-sm text-kk-muted mt-1 max-w-xl">{project.description}</p>
          )}
        </div>
        {canEdit && (
          <div className="flex gap-2 shrink-0">
            <ProjectLifecycleButtons projectId={project.id} currentStatus={project.status} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: meta + tasks */}
        <div className="col-span-2 space-y-6">
          {/* Task list */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Tasks <span className="text-kk-muted font-normal">· {tasks?.length || 0} total</span>
              </h2>
              <Link
                href={`/tasks/new?project_id=${project.id}`}
                className="text-xs px-3 py-1.5 bg-kk-soft border border-kk-line rounded-lg text-kk-ink hover:bg-kk-line transition-colors"
              >
                + Task
              </Link>
            </div>
            <TaskList tasks={tasks || []} currentUser={user} showProject={false} />
          </div>

          {/* Waiting Ons */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Waiting Ons <span className="text-kk-muted font-normal">· {waitingOns?.length || 0}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {(waitingOns ?? []).map((wo) => {
                const woOwner = Array.isArray(wo.owner) ? wo.owner[0] : wo.owner
                const waitingForUser = Array.isArray(wo.waiting_for_user) ? wo.waiting_for_user[0] : wo.waiting_for_user
                const now = new Date().toISOString()
                const isOverdue = wo.status === 'open' && wo.due_at && wo.due_at < now

                return (
                  <Link
                    key={wo.id}
                    href={`/waiting-ons/${wo.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                          {wo.title}
                        </span>
                        <WaitingOnStatusBadge status={(isOverdue ? 'overdue' : wo.status) as WaitingStatus} />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {(waitingForUser?.display_name || wo.waiting_for_name) && (
                          <span className="text-xs text-kk-muted">
                            Waiting on: {waitingForUser?.display_name || wo.waiting_for_name}
                          </span>
                        )}
                        {woOwner && (
                          <span className="text-xs text-kk-muted">· {woOwner.display_name}</span>
                        )}
                      </div>
                    </div>
                    {wo.due_at && (
                      <div className={`text-xs shrink-0 ${isOverdue ? 'text-kk-bad font-medium' : 'text-kk-muted'}`}>
                        {new Date(wo.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </div>
                    )}
                  </Link>
                )
              })}
              {(!waitingOns || waitingOns.length === 0) && (
                <div className="px-5 py-8 text-center text-sm text-kk-muted">
                  No linked waiting ons.
                </div>
              )}
            </div>
          </div>

          {/* Decisions */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Decisions <span className="text-kk-muted font-normal">· {decisions?.length || 0}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {(decisions ?? []).map((d) => {
                const dOwner = Array.isArray(d.owner) ? d.owner[0] : d.owner

                return (
                  <Link
                    key={d.id}
                    href={`/decisions/${d.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                          {d.title}
                        </span>
                        <DecisionStatusBadge status={d.status as DecisionStatus} />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {dOwner && (
                          <span className="text-xs text-kk-muted">{dOwner.display_name}</span>
                        )}
                        {d.decided_at && (
                          <span className="text-xs text-kk-muted">
                            · {new Date(d.decided_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                )
              })}
              {(!decisions || decisions.length === 0) && (
                <div className="px-5 py-8 text-center text-sm text-kk-muted">
                  No linked decisions.
                </div>
              )}
            </div>
          </div>

          {/* Meetings */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">
                Meetings <span className="text-kk-muted font-normal">· {meetings?.length || 0}</span>
              </h2>
            </div>
            <div className="divide-y divide-kk-line">
              {(meetings ?? []).map((m) => {
                const mOwner = Array.isArray(m.owner) ? m.owner[0] : m.owner
                return (
                  <Link
                    key={m.id}
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                          {m.title}
                        </span>
                        <MeetingStatusBadge status={m.status as MeetingStatus} />
                      </div>
                      {mOwner && (
                        <span className="text-xs text-kk-muted">{mOwner.display_name}</span>
                      )}
                    </div>
                    {m.scheduled_start && (
                      <div className="text-xs text-kk-muted shrink-0">
                        {new Date(m.scheduled_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </div>
                    )}
                  </Link>
                )
              })}
              {(!meetings || meetings.length === 0) && (
                <div className="px-5 py-8 text-center text-sm text-kk-muted">
                  No linked meetings.
                </div>
              )}
            </div>
          </div>

          {/* Edit form */}
          {canEdit && (
            <div className="bg-kk-panel border border-kk-line rounded-2xl">
              <div className="px-5 py-4 border-b border-kk-line">
                <h2 className="text-sm font-semibold text-kk-ink">Edit project</h2>
              </div>
              <div className="p-5">
                <ProjectForm
                  mode="edit"
                  project={project}
                  currentUser={user}
                  allUsers={allUsers}
                />
              </div>
            </div>
          )}

          {/* History */}
          <div className="bg-kk-panel border border-kk-line rounded-2xl">
            <div className="px-5 py-4 border-b border-kk-line">
              <h2 className="text-sm font-semibold text-kk-ink">History</h2>
            </div>
            <div className="px-5 py-2">
              <Suspense fallback={<div className="py-4 text-xs text-kk-muted">Loading history…</div>}>
                <AuditHistory entityType="project" entityId={project.id} />
              </Suspense>
            </div>
          </div>
        </div>

        {/* Right: project info */}
        <div className="space-y-4">
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 space-y-3">
            <div>
              <div className="text-xs text-kk-muted mb-0.5">Project lead</div>
              <div className="text-sm font-medium text-kk-ink">
                {owner?.display_name || '—'}
              </div>
            </div>

            <div>
              <div className="text-xs text-kk-muted mb-0.5">Status</div>
              <ProjectStatusBadge status={project.status} />
            </div>

            {project.due_date && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Due</div>
                <div className={`text-sm font-medium ${isOverdue ? 'text-kk-bad' : 'text-kk-ink'}`}>
                  {new Date(project.due_date).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'long', year: 'numeric'
                  })}
                  {isOverdue && ' · Overdue'}
                </div>
              </div>
            )}

            {project.start_date && (
              <div>
                <div className="text-xs text-kk-muted mb-0.5">Started</div>
                <div className="text-sm text-kk-ink">
                  {new Date(project.start_date).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'long', year: 'numeric'
                  })}
                </div>
              </div>
            )}

            {project.progress !== null && (
              <div>
                <div className="flex justify-between text-xs text-kk-muted mb-1">
                  <span>Progress</span>
                  <span>{project.progress}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${project.progress}%` }} />
                </div>
              </div>
            )}

            <div className="border-t border-kk-line pt-3">
              <div className="text-xs text-kk-muted mb-0.5">Created by</div>
              <div className="text-sm text-kk-ink">{creator?.display_name || '—'}</div>
              <div className="text-xs text-kk-muted mt-0.5">
                {new Date(project.created_at).toLocaleDateString('en-GB', {
                  day: 'numeric', month: 'short', year: 'numeric'
                })}
              </div>
            </div>
          </div>

          <RelatedFilesSection
            entityType="project"
            entityId={project.id}
            initialFiles={driveFiles}
            canManage={canEdit}
            driveEnabled={driveEnabled}
          />
        </div>
      </div>
    </div>
  )
}
