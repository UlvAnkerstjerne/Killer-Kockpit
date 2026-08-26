import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { ProjectStatusBadge } from '@/components/ui/StatusBadge'
import EmptyState from '@/components/ui/EmptyState'
import type { ViewMode } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage({
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
    .from('projects')
    .select(`
      id, title, description, status, due_date, progress, owner_user_id, created_at,
      owner:owner_user_id (id, display_name, email)
    `)
    .is('archived_at', null)
    .order('created_at', { ascending: false })

  if (view === 'personal') {
    query = query.eq('owner_user_id', user.id)
  }

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  }

  const { data: projects, error } = await query

  if (error) {
    return (
      <div className="p-4 rounded-xl bg-kk-bad-bg border border-red-200 text-kk-bad text-sm">
        Failed to load projects. Please refresh.
      </div>
    )
  }

  const statusCounts = {
    active: projects?.filter(p => p.status === 'active').length || 0,
    at_risk: projects?.filter(p => p.status === 'at_risk').length || 0,
    blocked: projects?.filter(p => p.status === 'blocked').length || 0,
    planned: projects?.filter(p => p.status === 'planned').length || 0,
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-kk-ink">Projects</h1>
          <p className="text-sm text-kk-muted mt-0.5">
            {view === 'management' ? 'All organisation projects' : 'Your projects'}
          </p>
        </div>
        <Link
          href="/projects/new"
          className="px-4 py-2 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
        >
          New project
        </Link>
      </div>

      {/* Summary counts */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Active', count: statusCounts.active, status: 'active' },
          { label: 'At risk', count: statusCounts.at_risk, status: 'at_risk' },
          { label: 'Blocked', count: statusCounts.blocked, status: 'blocked' },
          { label: 'Planned', count: statusCounts.planned, status: 'planned' },
        ].map(({ label, count, status }) => (
          <Link
            key={status}
            href={`/projects?view=${view}&status=${statusFilter === status ? '' : status}`}
            className={[
              'bg-kk-panel border rounded-xl p-4 hover:border-kk-ink transition-colors',
              statusFilter === status ? 'border-kk-ink' : 'border-kk-line',
            ].join(' ')}
          >
            <div className="text-xs text-kk-muted">{label}</div>
            <div className="text-2xl font-black tracking-tight text-kk-ink mt-0.5">{count}</div>
          </Link>
        ))}
      </div>

      {/* Project list */}
      {!projects || projects.length === 0 ? (
        <div className="bg-kk-panel border border-kk-line rounded-2xl">
          <EmptyState
            title="No projects yet"
            description={view === 'personal' ? 'Projects you own will appear here.' : 'No active projects in the organisation.'}
          />
        </div>
      ) : (
        <div className="bg-kk-panel border border-kk-line rounded-2xl divide-y divide-kk-line">
          {projects.map((project) => {
            const owner = Array.isArray(project.owner) ? project.owner[0] : project.owner
            const isOverdue = project.due_date && new Date(project.due_date) < new Date() && project.status !== 'completed'

            return (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="flex items-center gap-4 px-5 py-4 hover:bg-kk-soft transition-colors first:rounded-t-2xl last:rounded-b-2xl group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-kk-ink group-hover:underline truncate">
                      {project.title}
                    </span>
                    <ProjectStatusBadge status={project.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    {owner && (
                      <span className="text-xs text-kk-muted">{owner.display_name}</span>
                    )}
                    {project.due_date && (
                      <span className={`text-xs ${isOverdue ? 'text-kk-bad font-medium' : 'text-kk-muted'}`}>
                        {isOverdue ? 'Overdue · ' : 'Due '}
                        {new Date(project.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </div>
                </div>
                {project.progress !== null && (
                  <div className="w-24 shrink-0">
                    <div className="flex justify-end mb-1">
                      <span className="text-xs text-kk-muted">{project.progress}%</span>
                    </div>
                    <div className="progress-bar">
                      <div className="progress-bar-fill" style={{ width: `${project.progress}%` }} />
                    </div>
                  </div>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
