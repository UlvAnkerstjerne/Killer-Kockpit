import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { ProjectStatusBadge } from '@/components/ui/StatusBadge'
import TaskList from '@/components/tasks/TaskList'
import type { ViewMode, ProjectStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null

  const view = (params.view || (canAccessManagementView(user.role) ? 'management' : 'personal')) as ViewMode
  const canManage = canAccessManagementView(user.role)
  const supabase = await createClient()
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()

  // My tasks due today
  const { data: myTasksDueToday } = await supabase
    .from('tasks')
    .select(`id, title, status, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name, email)`)
    .eq('owner_user_id', user.id)
    .gte('due_at', todayStart)
    .lt('due_at', todayEnd)
    .not('status', 'in', '("done","cancelled")')
    .is('archived_at', null)
    .order('priority')

  // My overdue tasks
  const { data: myOverdueTasks } = await supabase
    .from('tasks')
    .select(`id, title, status, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name, email)`)
    .eq('owner_user_id', user.id)
    .lt('due_at', todayStart)
    .not('status', 'in', '("done","cancelled")')
    .is('archived_at', null)
    .order('due_at')
    .limit(10)

  // My projects
  const { data: myProjects } = await supabase
    .from('projects')
    .select(`id, title, status, due_date, progress, owner_user_id, owner:owner_user_id (id, display_name, email)`)
    .eq('owner_user_id', user.id)
    .is('archived_at', null)
    .not('status', 'in', '("completed","archived")')
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(8)

  // Management-only data
  type OrgProject = { id: string; title: string; status: ProjectStatus; due_date: string | null; progress: number | null; owner: { id: string; display_name: string; email: string } | Array<{ id: string; display_name: string; email: string }> | undefined }
  type OrgTask = { id: string; title: string; status: string; priority: number; due_at: string | null; completed_at: string | null; owner_user_id: string | null; owner: { id: string; display_name: string; email: string } | Array<{ id: string; display_name: string; email: string }> | undefined }
  let blockedProjects: OrgProject[] = []
  let atRiskProjects: OrgProject[] = []
  let orgOverdueTasks: OrgTask[] = []

  if (view === 'management' && canManage) {
    const [blocked, atRisk, overdue] = await Promise.all([
      supabase
        .from('projects')
        .select(`id, title, status, due_date, progress, owner:owner_user_id (id, display_name, email)`)
        .eq('status', 'blocked')
        .is('archived_at', null)
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(5),

      supabase
        .from('projects')
        .select(`id, title, status, due_date, progress, owner:owner_user_id (id, display_name, email)`)
        .eq('status', 'at_risk')
        .is('archived_at', null)
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(5),

      supabase
        .from('tasks')
        .select(`id, title, status, priority, due_at, completed_at, owner_user_id, owner:owner_user_id (id, display_name, email)`)
        .lt('due_at', todayStart)
        .not('status', 'in', '("done","cancelled")')
        .is('archived_at', null)
        .order('due_at')
        .limit(10),
    ])

    blockedProjects = (blocked.data || []) as OrgProject[]
    atRiskProjects = (atRisk.data || []) as OrgProject[]
    orgOverdueTasks = (overdue.data || []) as OrgTask[]
  }

  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Today</h1>
        <p className="text-sm text-kk-muted mt-0.5">{today}</p>
      </div>

      <div className="grid grid-cols-3 gap-5">

        {/* Tasks due today */}
        <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
            <h2 className="text-sm font-semibold text-kk-ink">
              My tasks due today
              {myTasksDueToday && myTasksDueToday.length > 0 && (
                <span className="text-kk-muted font-normal ml-1">· {myTasksDueToday.length}</span>
              )}
            </h2>
            <Link href="/tasks?status=open" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
              All tasks →
            </Link>
          </div>
          <TaskList tasks={myTasksDueToday || []} currentUser={user} showProject={true} />
          {(!myTasksDueToday || myTasksDueToday.length === 0) && (
            <div className="px-5 py-6 text-center text-sm text-kk-muted">
              Nothing due today.
            </div>
          )}
        </div>

        {/* Overdue */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line">
            <h2 className="text-sm font-semibold text-kk-ink">
              Overdue
              {myOverdueTasks && myOverdueTasks.length > 0 && (
                <span className="text-kk-bad font-normal ml-1">· {myOverdueTasks.length}</span>
              )}
            </h2>
          </div>
          {!myOverdueTasks || myOverdueTasks.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-kk-muted">No overdue tasks.</div>
          ) : (
            <div className="divide-y divide-kk-line">
              {myOverdueTasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-kk-soft transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-kk-ink font-medium truncate">{task.title}</div>
                    <div className="text-xs text-kk-bad mt-0.5">
                      {new Date(task.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* My projects */}
        <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
          <div className="px-5 py-4 border-b border-kk-line flex items-center justify-between">
            <h2 className="text-sm font-semibold text-kk-ink">My projects</h2>
            <Link href="/projects" className="text-xs text-kk-muted hover:text-kk-ink transition-colors">
              All projects →
            </Link>
          </div>
          {!myProjects || myProjects.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-kk-muted">
              No active projects you own.
            </div>
          ) : (
            <div className="divide-y divide-kk-line">
              {myProjects.map((project) => {
                const isOverdue = project.due_date && new Date(project.due_date) < now
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-kk-soft transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-kk-ink group-hover:underline truncate">
                          {project.title}
                        </span>
                        <ProjectStatusBadge status={project.status} />
                      </div>
                      {project.due_date && (
                        <div className={`text-xs mt-0.5 ${isOverdue ? 'text-kk-bad' : 'text-kk-muted'}`}>
                          Due {new Date(project.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </div>
                      )}
                    </div>
                    {project.progress !== null && (
                      <div className="w-20 shrink-0">
                        <div className="text-xs text-kk-muted text-right mb-1">{project.progress}%</div>
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

        {/* Deferred integrations placeholder */}
        <div className="bg-kk-panel border border-kk-line rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-kk-ink mb-3">Upcoming integrations</h2>
          <div className="space-y-3">
            <div className="p-3 bg-kk-soft rounded-xl border border-kk-line">
              <div className="text-xs font-medium text-kk-muted">Calendar</div>
              <div className="text-xs text-kk-muted mt-0.5">Not connected yet</div>
            </div>
            <div className="p-3 bg-kk-soft rounded-xl border border-kk-line">
              <div className="text-xs font-medium text-kk-muted">Gmail</div>
              <div className="text-xs text-kk-muted mt-0.5">Not connected yet</div>
            </div>
            <div className="p-3 bg-kk-soft rounded-xl border border-kk-line">
              <div className="text-xs font-medium text-kk-muted">Meetings</div>
              <div className="text-xs text-kk-muted mt-0.5">Not connected yet</div>
            </div>
          </div>
        </div>

        {/* Management: blocked projects */}
        {view === 'management' && canManage && (
          <>
            {blockedProjects.length > 0 && (
              <div className="bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line">
                  <h2 className="text-sm font-semibold text-kk-ink">
                    Blocked projects <span className="text-kk-bad">· {blockedProjects.length}</span>
                  </h2>
                </div>
                <div className="divide-y divide-kk-line">
                  {blockedProjects.map((p) => {
                    const owner = Array.isArray(p.owner) ? p.owner[0] : p.owner
                    return (
                      <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-kk-ink group-hover:underline truncate">{p.title}</div>
                          {owner && <div className="text-xs text-kk-muted mt-0.5">{owner.display_name}</div>}
                        </div>
                        <ProjectStatusBadge status={p.status} />
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}

            {atRiskProjects.length > 0 && (
              <div className="bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line">
                  <h2 className="text-sm font-semibold text-kk-ink">
                    At risk <span className="text-kk-warn">· {atRiskProjects.length}</span>
                  </h2>
                </div>
                <div className="divide-y divide-kk-line">
                  {atRiskProjects.map((p) => {
                    const owner = Array.isArray(p.owner) ? p.owner[0] : p.owner
                    return (
                      <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-kk-soft transition-colors group">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-kk-ink group-hover:underline truncate">{p.title}</div>
                          {owner && <div className="text-xs text-kk-muted mt-0.5">{owner.display_name}</div>}
                        </div>
                        <ProjectStatusBadge status={p.status} />
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}

            {orgOverdueTasks.length > 0 && (
              <div className="col-span-2 bg-kk-panel border border-kk-line rounded-2xl">
                <div className="px-5 py-4 border-b border-kk-line">
                  <h2 className="text-sm font-semibold text-kk-ink">
                    Overdue across organisation <span className="text-kk-bad">· {orgOverdueTasks.length}</span>
                  </h2>
                </div>
                <TaskList tasks={orgOverdueTasks} currentUser={user} showProject={true} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
