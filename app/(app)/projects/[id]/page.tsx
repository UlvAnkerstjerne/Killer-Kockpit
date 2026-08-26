import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser, getActiveUsers } from '@/lib/auth'
import { canEditProject } from '@/lib/permissions'
import { ProjectStatusBadge } from '@/components/ui/StatusBadge'
import AuditHistory from '@/components/ui/AuditHistory'
import ProjectForm from '@/components/projects/ProjectForm'
import TaskList from '@/components/tasks/TaskList'
import ArchiveProjectButton from '@/components/projects/ArchiveProjectButton'

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

  const { data: tasks } = await supabase
    .from('tasks')
    .select(`
      id, title, status, priority, due_at, completed_at, owner_user_id,
      owner:owner_user_id (id, display_name, email)
    `)
    .eq('project_id', id)
    .is('archived_at', null)
    .order('created_at', { ascending: false })

  const canEdit = canEditProject(user.role, project.owner_user_id, user.id)
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
            <ArchiveProjectButton projectId={project.id} />
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
              <AuditHistory entityType="project" entityId={project.id} />
            </div>
          </div>
        </div>

        {/* Right: project info */}
        <div className="space-y-4">
          <div className="bg-kk-panel border border-kk-line rounded-2xl p-4 space-y-3">
            <div>
              <div className="text-xs text-kk-muted mb-0.5">Owner</div>
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
        </div>
      </div>
    </div>
  )
}
